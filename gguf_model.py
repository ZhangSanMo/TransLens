import asyncio
import collections
import hashlib
import json
import os
import random
import time
from configparser import ConfigParser, NoSectionError, NoOptionError
from contextlib import asynccontextmanager

import aiosqlite
import httpx
import jieba.posseg as pseg
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict

# ==============================================================================
# 0. 全局变量、自定义异常和应用生命周期
# ==============================================================================
DATABASE_FILE = "translens_data.db"
config = None
translation_provider = None
translation_cache = None

# <<< 1. 定义一个自定义异常，用于清晰地表示客户端断开连接
class ClientDisconnectedError(Exception):
    """当检测到客户端断开连接时引发的异常。"""
    pass

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ... (这部分与之前完全相同，无需修改) ...
    print("--- 应用启动 ---")
    global config, translation_provider, translation_cache
    load_dotenv()
    print("已加载 .env 文件中的环境变量。")
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
        print(f"已连接并初始化数据库: '{DATABASE_FILE}'")
        translation_provider = TranslationProvider(provider_name, config)
        translation_cache = TranslationCache()
    except (ValueError, NoSectionError, NoOptionError) as e:
        print(f"\n[错误] 初始化提供者失败: {e}")
        exit(1)
    print("-" * 50)
    print("--- 服务初始化完成，准备接收请求 ---")
    yield
    print("--- 应用关闭 ---")

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==============================================================================
# 1. 数据库管理 (添加新表)
# ==============================================================================
async def get_db():
    db = await aiosqlite.connect(DATABASE_FILE)
    db.row_factory = aiosqlite.Row # 方便按列名访问
    try:
        yield db
    finally:
        await db.close()

async def init_db():
    async with aiosqlite.connect(DATABASE_FILE) as db:
        # 缓存表
        await db.execute("""
        CREATE TABLE IF NOT EXISTS translation_cache (
            key TEXT PRIMARY KEY, sentence TEXT NOT NULL, target_word TEXT NOT NULL,
            translation TEXT NOT NULL, timestamp INTEGER NOT NULL
        )""")
        # 词频表
        await db.execute("""
        CREATE TABLE IF NOT EXISTS word_frequency (
            word TEXT PRIMARY KEY, frequency INTEGER NOT NULL DEFAULT 0
        )""")
        # <<< 新增功能：记忆曲线/“太简单”单词表
        await db.execute("""
        CREATE TABLE IF NOT EXISTS word_memory (
            word TEXT PRIMARY KEY,
            level INTEGER NOT NULL DEFAULT 1,
            suppress_until INTEGER NOT NULL
        )""")
        await db.commit()
        print("数据库表初始化完成。")

# ==============================================================================
# 2. API 提供者 (核心改造)
# ==============================================================================
class TranslationProvider:
    def __init__(self, provider_name, config: ConfigParser):
        if not config.has_section(provider_name):
            raise ValueError(f"配置错误: 在 config.ini 中未找到名为 '[{provider_name}]' 的配置节")
        provider_config, default_config = config[provider_name], config["DEFAULT"]
        def get_config_value(section, key, fallback=""):
            return os.path.expandvars(section.get(key, fallback))
        self.provider_name = provider_name
        self.api_url = get_config_value(provider_config, "api_url")
        self.model = get_config_value(provider_config, "model", fallback="default")
        self.api_key = get_config_value(provider_config, "api_key", fallback="")
        self.use_system_role = provider_config.getboolean("use_system_role", True)
        self.system_prompt = get_config_value(provider_config, "system_prompt", fallback=get_config_value(default_config, "system_prompt"))
        self.proxy = get_config_value(provider_config, "proxy", fallback=get_config_value(default_config, "proxy", None))
        self.custom_headers = {key[len("header_") :].replace("_", "-").title(): os.path.expandvars(value) for key, value in provider_config.items() if key.startswith("header_")}
        self.rate_limit_count = provider_config.getint("rate_limit_count", fallback=default_config.getint("rate_limit_count", 0))
        self.rate_limit_period = provider_config.getint("rate_limit_period_seconds", fallback=default_config.getint("rate_limit_period_seconds", 60))
        if self.rate_limit_count > 0:
            self.request_timestamps = collections.deque()
            self.rate_limit_lock = asyncio.Lock()
            print(f"[{self.provider_name}] 已启用速率限制: 每 {self.rate_limit_period} 秒最多 {self.rate_limit_count} 次请求。")
        else:
            print(f"[{self.provider_name}] 未启用速率限制。")

    def _build_headers(self):
        headers = {"Content-Type": "application/json"}
        if self.api_key and self.api_key != "no-key-required": headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self.custom_headers); return headers

    def _build_payload(self, prompt):
        messages = []
        if self.use_system_role:
            messages.extend([{"role": "system", "content": self.system_prompt}, {"role": "user", "content": prompt}])
        else:
            messages.append({"role": "user", "content": f"{self.system_prompt}\n\n---\n\n{prompt}"})
        return {"model": self.model, "messages": messages}
    
    def _parse_response(self, response_json):
        return response_json["choices"][0]["message"]["content"]


    # <<< 2. 核心改造点：改造速率限制器，使其可中断
    async def _wait_for_rate_limit(self, request: Request):
        if self.rate_limit_count <= 0: return

        async with self.rate_limit_lock:
            current_time = time.time()
            while self.request_timestamps and self.request_timestamps[0] < current_time - self.rate_limit_period:
                self.request_timestamps.popleft()

            if len(self.request_timestamps) >= self.rate_limit_count:
                wait_time = self.request_timestamps[0] + self.rate_limit_period - current_time
                if wait_time > 0:
                    print(f"[{self.provider_name}] 达到速率限制，将等待 {wait_time:.2f} 秒...")
                    
                    # 将一次长等待分解为多次短等待，并在每次等待后检查连接状态
                    end_time = time.time() + wait_time
                    while time.time() < end_time:
                        # 核心检查！
                        if await request.is_disconnected():
                            print(f"[{self.provider_name}] 客户端已断开连接，中断等待。")
                            raise ClientDisconnectedError()
                        # 等待一小段时间
                        await asyncio.sleep(0.1)
            
            # 如果客户端在等待期间断开，这里的代码将不会执行
            self.request_timestamps.append(time.time())

    # <<< 3. 改造 translate 方法，接收 request 对象
    async def translate(self, sentence: str, target_word: str, request: Request):
        # 将 request 对象传递给速率限制器
        await self._wait_for_rate_limit(request)
        
        # <<< 4. 在发起昂贵的API调用前，再做一次最终检查
        if await request.is_disconnected():
            print(f"[{self.provider_name}] 客户端在等待后、请求前断开连接，取消API调用。")
            raise ClientDisconnectedError()

        prompt = f"翻译下面句子中的「{target_word}」：{sentence}"
        headers = self._build_headers()
        payload = self._build_payload(prompt)

        try:
            async with httpx.AsyncClient(proxy=self.proxy, timeout=30.0) as client:
                response = await client.post(self.api_url, headers=headers, json=payload)
                response.raise_for_status()
            translated_content = self._parse_response(response.json())
            if len(translated_content) > 30:
                raise ValueError(f"翻译结果过长:{translated_content}")
            return translated_content
        except httpx.RequestError as e:
            print(f"[{self.provider_name}] 调用 API 失败: {e}")
            raise
        except (KeyError, IndexError, ValueError) as e:
            print(f"[{self.provider_name}] 解析响应失败: {e}")
            raise

# ==============================================================================
# 3. 缓存系统 (新增了与新表交互的方法)
# ==============================================================================
class TranslationCache:
    def _generate_key(self, sentence, target_word):
        return hashlib.md5(f"{sentence}|{target_word}".encode("utf-8")).hexdigest()
    async def get(self, sentence, target_word, db: aiosqlite.Connection):
        key = self._generate_key(sentence, target_word)
        async with db.execute("SELECT translation FROM translation_cache WHERE key = ?", (key,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else None
    async def set(self, sentence, target_word, translation, db: aiosqlite.Connection):
        key, timestamp = self._generate_key(sentence, target_word), int(time.time())
        await db.execute("INSERT OR REPLACE INTO translation_cache VALUES (?, ?, ?, ?, ?)", (key, sentence, target_word, translation, timestamp))
        await db.commit()
    async def get_word_frequency(self, word, db: aiosqlite.Connection):
        async with db.execute("SELECT frequency FROM word_frequency WHERE word = ?", (word,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else 0
    async def increment_word_frequency(self, word, db: aiosqlite.Connection):
        async with db.execute("UPDATE word_frequency SET frequency = frequency + 1 WHERE word = ?", (word,)) as cursor:
            if cursor.rowcount == 0:
                await db.execute("INSERT INTO word_frequency (word, frequency) VALUES (?, 1)", (word,))
        await db.commit()
        new_freq = await self.get_word_frequency(word, db)
        print(f"词语 '{word}' 选择次数更新为: {new_freq}")
    async def weighted_choice(self, words, db: aiosqlite.Connection):
        if not words: return None
        if len(words) == 1: return words[0]
        freq_tasks = [self.get_word_frequency(word, db) for word in words]
        frequencies = await asyncio.gather(*freq_tasks)
        weights = [1.0 / (freq + 1) for freq in frequencies]
        return random.choices(words, weights=weights, k=1)[0]
    
    # <<< 新增功能：获取未被抑制的单词
    async def get_eligible_words(self, words: List[str], db: aiosqlite.Connection) -> List[str]:
        if not words:
            return []
        
        # 使用参数化查询防止SQL注入
        placeholders = ','.join('?' for _ in words)
        query = f"SELECT word FROM word_memory WHERE word IN ({placeholders}) AND suppress_until > ?"
        
        current_time = int(time.time())
        
        async with db.execute(query, words + [current_time]) as cursor:
            suppressed_words = {row['word'] for row in await cursor.fetchall()}

        if suppressed_words:
            print(f"过滤掉以下简单词: {', '.join(suppressed_words)}")
            
        eligible = [word for word in words if word not in suppressed_words]
        return eligible

# ==============================================================================
# 4. FastAPI 端点 (核心改造)
# ==============================================================================
@app.post("/translate")
async def translate_word(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    try:
        data = await request.json()
        context_sentence = data.get("sentence")
        if not context_sentence:
            raise HTTPException(status_code=400, detail="JSON中必须包含 'sentence' 字段")

        words = pseg.lcut(context_sentence)
        candidate_words = list(set([word for word, flag in words if flag.startswith("n") or flag.startswith("v")]))
        if not candidate_words:
            raise HTTPException(status_code=404, detail="句子中未找到可翻译的名词或动词")

        # <<< 新增功能：从候选词中过滤掉“太简单”的词
        eligible_words = await translation_cache.get_eligible_words(candidate_words, db)
        if not eligible_words:
            print("所有候选词都因“太简单”被过滤，本次不翻译。")
            raise HTTPException(status_code=404, detail="所有候选词均被标记为简单词")

        target_word = await translation_cache.weighted_choice(eligible_words, db)
        if not target_word:
             raise HTTPException(status_code=404, detail="无法从合格词中选择目标词")

        await translation_cache.increment_word_frequency(target_word, db)

        cached = await translation_cache.get(context_sentence, target_word, db)
        if cached:
            print(f"从缓存命中: {target_word} -> {cached}")
            return {"target_word": target_word, "translation": cached, "from_cache": True}

        print(f"通过 [{translation_provider.provider_name}] API 翻译: {target_word}")
        
        translated_content = await translation_provider.translate(
            context_sentence, target_word, request=request
        )
        
        await translation_cache.set(context_sentence, target_word, translated_content, db)
        print(f"翻译结果已缓存: {target_word} -> {translated_content}")
        return {"target_word": target_word, "translation": translated_content, "from_cache": False}

    except ClientDisconnectedError:
        print("请求处理被中断，因为客户端已断开连接。")
        return 
    except Exception as e:
        print(f"处理翻译请求时发生未知错误: {e}")
        raise HTTPException(status_code=502, detail=f"处理翻译请求时发生错误: {str(e)}")


# <<< 新增功能：标记单词为“太简单”的端点
@app.post("/mark_easy")
async def mark_word_as_easy(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    try:
        data = await request.json()
        word = data.get("word")
        if not word:
            raise HTTPException(status_code=400, detail="JSON中必须包含 'word' 字段")

        # 查找现有等级
        async with db.execute("SELECT level FROM word_memory WHERE word = ?", (word,)) as cursor:
            row = await cursor.fetchone()
        
        current_level = row['level'] if row else 0
        new_level = current_level + 1

        # 计算抑制时间（遗忘曲线）: level^2 天
        # Level 1: 1 day, Level 2: 4 days, Level 3: 9 days, etc.
        days_to_suppress = new_level ** 2
        suppress_duration_seconds = days_to_suppress * 24 * 60 * 60
        suppress_until_timestamp = int(time.time()) + suppress_duration_seconds

        await db.execute(
            "INSERT OR REPLACE INTO word_memory (word, level, suppress_until) VALUES (?, ?, ?)",
            (word, new_level, suppress_until_timestamp)
        )
        await db.commit()
        
        print(f"单词 '{word}' 已被标记为简单 (等级: {new_level}). 在 {days_to_suppress} 天内将不再翻译.")
        return {"status": "success", "word": word, "new_level": new_level, "suppress_days": days_to_suppress}

    except Exception as e:
        print(f"处理 '/mark_easy' 请求时发生错误: {e}")
        raise HTTPException(status_code=500, detail=f"服务器内部错误: {str(e)}")


# ==============================================================================
# 5. 主程序入口 (无需修改)
# ==============================================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5000)