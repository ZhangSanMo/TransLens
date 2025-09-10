import requests
import jieba.posseg as pseg
import random
import json
import os
import hashlib
import time
import aiosqlite
import collections
import asyncio
from configparser import ConfigParser, NoSectionError, NoOptionError

# --- FastAPI 相关导入 ---
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from dotenv import load_dotenv
import httpx

# ==============================================================================
# 0. 全局变量和应用生命周期管理
# ==============================================================================
DATABASE_FILE = "translens_data.db"
# 将这些变量设为全局，在 startup 事件中初始化
config = None
translation_provider = None
translation_cache = None


# FastAPI 的应用生命周期事件，用于在应用启动时初始化资源
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 应用启动时执行
    print("--- 应用启动 ---")
    global config, translation_provider, translation_cache

    load_dotenv()
    print("已加载 .env 文件中的环境变量。")

    # 注意：命令行参数解析在 FastAPI 中通常不这么用，我们直接从配置读取
    # 如果需要动态指定 provider, 推荐使用环境变量
    # PROVIDER_NAME = os.getenv("TRANSLENS_PROVIDER", "local_llama")

    config = ConfigParser()
    config.read("config.ini", encoding="utf-8")

    default_provider_from_config = os.path.expandvars(
        config.get("DEFAULT", "provider", fallback="local_llama")
    )
    provider_name = os.getenv("TRANSLENS_PROVIDER", default_provider_from_config)

    print("-" * 50)
    print(f"准备启动服务，使用 API 提供者: '{provider_name}'")

    try:
        if not os.path.exists(DATABASE_FILE):
            print(f"数据库文件 '{DATABASE_FILE}' 不存在，正在创建...")
            await init_db()
        else:
            print(f"已连接到现有数据库: '{DATABASE_FILE}'")

        translation_provider = TranslationProvider(provider_name, config)
        translation_cache = TranslationCache()

    except (ValueError, NoSectionError, NoOptionError) as e:
        print(f"\n[错误] 初始化提供者失败: {e}")
        print("请检查您的环境变量和 config.ini 文件是否正确。\n")
        exit(1)

    print("-" * 50)
    print("--- 服务初始化完成，准备接收请求 ---")
    yield
    # 应用关闭时执行 (如果需要)
    print("--- 应用关闭 ---")


app = FastAPI(lifespan=lifespan)

# 配置 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源，生产环境建议收紧
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==============================================================================
# 1. 数据库管理 (异步改造)
# ==============================================================================
async def get_db():
    """
    FastAPI 依赖注入：提供一个异步数据库连接。
    """
    db = await aiosqlite.connect(DATABASE_FILE)
    try:
        yield db
    finally:
        await db.close()


async def init_db():
    """初始化数据库，创建表结构。"""
    async with aiosqlite.connect(DATABASE_FILE) as db:
        # 创建翻译缓存表
        await db.execute("""
        CREATE TABLE IF NOT EXISTS translation_cache (
            key TEXT PRIMARY KEY,
            sentence TEXT NOT NULL,
            target_word TEXT NOT NULL,
            translation TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        )
        """)
        # 创建词频表
        await db.execute("""
        CREATE TABLE IF NOT EXISTS word_frequency (
            word TEXT PRIMARY KEY,
            frequency INTEGER NOT NULL DEFAULT 0
        )
        """)
        await db.commit()
        print("数据库表初始化完成。")


# ==============================================================================
# 2. 统一且可扩展的 API 提供者 (异步改造)
# ==============================================================================
class TranslationProvider:
    def __init__(self, provider_name, config: ConfigParser):
        if not config.has_section(provider_name):
            raise ValueError(
                f"配置错误: 在 config.ini 中未找到名为 '[{provider_name}]' 的配置节"
            )
        provider_config = config[provider_name]
        default_config = config["DEFAULT"]

        def get_config_value(section, key, fallback=""):
            raw_value = section.get(key, fallback)
            return os.path.expandvars(raw_value)

        self.provider_name = provider_name
        self.api_url = get_config_value(provider_config, "api_url")
        self.model = get_config_value(provider_config, "model", fallback="default")
        self.api_key = get_config_value(provider_config, "api_key", fallback="")
        self.use_system_role = provider_config.getboolean("use_system_role", True)
        self.system_prompt = get_config_value(
            provider_config,
            "system_prompt",
            fallback=get_config_value(default_config, "system_prompt"),
        )
        self.proxy = get_config_value(
            provider_config,
            "proxy",
            fallback=get_config_value(default_config, "proxy", None),
        )
        self.custom_headers = {}
        for key, value in provider_config.items():
            if key.startswith("header_"):
                header_name = key[len("header_") :].replace("_", "-").title()
                self.custom_headers[header_name] = os.path.expandvars(value)
        self.rate_limit_count = provider_config.getint(
            "rate_limit_count", fallback=default_config.getint("rate_limit_count", 0)
        )
        self.rate_limit_period = provider_config.getint(
            "rate_limit_period_seconds",
            fallback=default_config.getint("rate_limit_period_seconds", 60),
        )

        if self.rate_limit_count > 0:
            self.request_timestamps = collections.deque()
            self.rate_limit_lock = asyncio.Lock()
            print(
                f"[{self.provider_name}] 已启用速率限制: 每 {self.rate_limit_period} 秒最多 {self.rate_limit_count} 次请求。"
            )
        else:
            print(f"[{self.provider_name}] 未启用速率限制。")

    async def _wait_for_rate_limit(self):
        """如果达到速率限制，则异步等待。"""
        if self.rate_limit_count <= 0:
            return

        async with self.rate_limit_lock:
            current_time = time.time()
            while (
                self.request_timestamps
                and self.request_timestamps[0] < current_time - self.rate_limit_period
            ):
                self.request_timestamps.popleft()

            if len(self.request_timestamps) >= self.rate_limit_count:
                wait_time = (
                    self.request_timestamps[0] + self.rate_limit_period - current_time
                )
                if wait_time > 0:
                    print(
                        f"[{self.provider_name}] 达到速率限制，等待 {wait_time:.2f} 秒..."
                    )
                    await asyncio.sleep(wait_time)
            self.request_timestamps.append(time.time())

    def _build_headers(self):
        headers = {"Content-Type": "application/json"}
        if self.api_key and self.api_key != "no-key-required":
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self.custom_headers)
        return headers

    def _build_payload(self, prompt):
        messages = []
        if self.use_system_role:
            messages.append({"role": "system", "content": self.system_prompt})
            messages.append({"role": "user", "content": prompt})
        else:
            full_prompt = f"{self.system_prompt}\n\n---\n\n{prompt}"
            messages.append({"role": "user", "content": full_prompt})
        return {"model": self.model, "messages": messages}

    def _parse_response(self, response_json):
        return response_json["choices"][0]["message"]["content"]

    async def translate(self, sentence, target_word):
        """执行翻译的完整流程 (异步)"""
        await self._wait_for_rate_limit()
        prompt = f"翻译下面句子中的「{target_word}」：{sentence}"

        headers = self._build_headers()
        payload = self._build_payload(prompt)

        try:
            async with httpx.AsyncClient(proxy=self.proxy, timeout=30.0) as client:
                response = await client.post(
                    self.api_url, headers=headers, json=payload
                )
                response.raise_for_status()

            translated_content = self._parse_response(response.json())
            if len(translated_content) > 30:
                raise ValueError("翻译结果过长")
            return translated_content

        except httpx.RequestError as e:
            print(f"[{self.provider_name}] 调用 API 失败: {e}")
            raise
        except (KeyError, IndexError, ValueError) as e:
            print(f"[{self.provider_name}] 解析响应失败: {e}")
            raise


# ==============================================================================
# 3. 缓存系统 (异步改造)
# ==============================================================================
class TranslationCache:
    """
    翻译缓存类，所有数据库操作都改为异步。
    """

    def _generate_key(self, sentence, target_word):
        key_string = f"{sentence}|{target_word}"
        return hashlib.md5(key_string.encode("utf-8")).hexdigest()

    async def get(self, sentence, target_word, db: aiosqlite.Connection):
        key = self._generate_key(sentence, target_word)
        cursor = await db.execute(
            "SELECT translation FROM translation_cache WHERE key = ?", (key,)
        )
        row = await cursor.fetchone()
        await cursor.close()
        return row[0] if row else None

    async def set(self, sentence, target_word, translation, db: aiosqlite.Connection):
        key = self._generate_key(sentence, target_word)
        timestamp = int(time.time())
        await db.execute(
            "INSERT OR REPLACE INTO translation_cache (key, sentence, target_word, translation, timestamp) VALUES (?, ?, ?, ?, ?)",
            (key, sentence, target_word, translation, timestamp),
        )
        await db.commit()

    async def increment_word_frequency(self, word, db: aiosqlite.Connection):
        cursor = await db.execute(
            "UPDATE word_frequency SET frequency = frequency + 1 WHERE word = ?",
            (word,),
        )
        if cursor.rowcount == 0:
            await db.execute(
                "INSERT INTO word_frequency (word, frequency) VALUES (?, 1)", (word,)
            )
        await db.commit()
        await cursor.close()
        new_freq = await self.get_word_frequency(word, db)
        print(f"词语 '{word}' 选择次数更新为: {new_freq}")

    async def get_word_frequency(self, word, db: aiosqlite.Connection):
        cursor = await db.execute(
            "SELECT frequency FROM word_frequency WHERE word = ?", (word,)
        )
        row = await cursor.fetchone()
        await cursor.close()
        return row[0] if row else 0

    async def weighted_choice(self, words, db: aiosqlite.Connection):
        if not words:
            return None
        if len(words) == 1:
            return words[0]

        # 并发获取所有词的频率
        freq_tasks = [self.get_word_frequency(word, db) for word in words]
        frequencies = await asyncio.gather(*freq_tasks)

        weights = [1.0 / (freq + 1) for freq in frequencies]
        return random.choices(words, weights=weights, k=1)[0]


# ==============================================================================
# 4. FastAPI 端点 (异步改造)
# ==============================================================================
@app.post("/translate")
async def translate_word(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    try:
        data = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="无效的JSON")

    if not data or "sentence" not in data:
        raise HTTPException(
            status_code=400, detail="请输入有效的JSON，并包含 'sentence' 字段"
        )

    context_sentence = data["sentence"]
    # jieba 不是异步的，但在CPU密集型任务中这通常没问题
    words = pseg.lcut(context_sentence)
    result = [
        word for word, flag in words if flag.startswith("n") or flag.startswith("v")
    ]
    if not result:
        raise HTTPException(status_code=404, detail="句子中未找到可翻译的名词或动词")

    target_word = await translation_cache.weighted_choice(result, db)
    await translation_cache.increment_word_frequency(target_word, db)

    cached = await translation_cache.get(context_sentence, target_word, db)
    if cached:
        print(f"从缓存命中: {target_word} -> {cached}")
        return {"target_word": target_word, "translation": cached, "from_cache": True}

    try:
        print(f"通过 [{translation_provider.provider_name}] API 翻译: {target_word}")
        translated_content = await translation_provider.translate(
            context_sentence, target_word
        )
        await translation_cache.set(
            context_sentence, target_word, translated_content, db
        )
        print(f"翻译结果已缓存: {target_word} -> {translated_content}")
        return {
            "target_word": target_word,
            "translation": translated_content,
            "from_cache": False,
        }
    except Exception as e:
        # 客户端取消请求时，httpx会抛出异常，FastAPI会捕获并正确处理连接关闭
        # 这里我们记录一个通用错误
        print(f"处理翻译请求时发生错误: {e}")
        raise HTTPException(status_code=502, detail=f"处理翻译请求时发生错误: {str(e)}")


# ==============================================================================
# 5. 主程序入口 (用于 Uvicorn)
# ==============================================================================
if __name__ == "__main__":
    # 这个部分现在只是为了方便直接运行（虽然不推荐用于生产）
    # 推荐的启动方式是: uvicorn gguf_model:app --reload
    import uvicorn

    print("正在以开发模式启动 Uvicorn 服务器...")
    print("推荐的生产启动方式是: uvicorn gguf_model:app --workers 4")
    uvicorn.run(app, host="127.0.0.1", port=5000)
