import requests
import jieba.posseg as pseg
import random
import json
import os
import hashlib
import time
import argparse
import sqlite3
import collections
import threading
from configparser import ConfigParser, NoSectionError, NoOptionError
from flask import Flask, request, jsonify, g  # <-- 1. 导入 g
from flask_cors import CORS
from dotenv import load_dotenv

# ==============================================================================
# 0. 数据库管理 (新)
# ==============================================================================
DATABASE_FILE = "translens_data.db"


def get_db():
    """
    为当前请求获取数据库连接。如果连接不存在，则创建一个新的。
    """
    db = getattr(g, "_database", None)
    if db is None:
        db = g._database = sqlite3.connect(DATABASE_FILE)
    return db


def init_db():
    """初始化数据库，创建表结构。"""
    with app.app_context():
        db = get_db()
        cursor = db.cursor()
        # 创建翻译缓存表
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS translation_cache (
            key TEXT PRIMARY KEY,
            sentence TEXT NOT NULL,
            target_word TEXT NOT NULL,
            translation TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        )
        """)
        # 创建词频表
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS word_frequency (
            word TEXT PRIMARY KEY,
            frequency INTEGER NOT NULL DEFAULT 0
        )
        """)
        db.commit()
        print("数据库表初始化完成。")


# ==============================================================================
# 1. 统一且可扩展的 API 提供者 (无变化)
# ==============================================================================
class TranslationProvider:
    def __init__(self, provider_name, config: ConfigParser):
        if not config.has_section(provider_name):
            raise ValueError(
                f"配置错误: 在 config.ini 中未找到名为 '[{provider_name}]' 的配置节"
            )

        provider_config = config[provider_name]
        default_config = config["DEFAULT"]

        # 环境变量解析辅助函数
        def get_config_value(section, key, fallback=""):
            """从配置中获取值，并解析环境变量。"""
            # ConfigParser 默认支持环境变量插值，但我们需要更灵活的处理
            # 使用 os.path.expandvars 来解析 ${VAR} 或 $VAR 格式
            raw_value = section.get(key, fallback)
            return os.path.expandvars(raw_value)

        self.provider_name = provider_name
        self.api_url = get_config_value(provider_config, "api_url")
        self.model = get_config_value(provider_config, "model", fallback="default")
        self.api_key = get_config_value(provider_config, "api_key", fallback="")
        self.use_system_role = provider_config.getboolean("use_system_role", True)

        # 优先使用 provider_config 的 system_prompt，否则回退到 default_config
        self.system_prompt = get_config_value(
            provider_config,
            "system_prompt",
            fallback=get_config_value(default_config, "system_prompt"),
        )

        # 优先使用 provider_config 的 proxy，否则回退到 default_config
        self.proxy = get_config_value(
            provider_config,
            "proxy",
            fallback=get_config_value(default_config, "proxy", None),
        )

        # 解析所有以 'header_' 开头的自定义请求头
        self.custom_headers = {}
        for key, value in provider_config.items():
            if key.startswith("header_"):
                # 将 'header_http-referer' 转换为 'HTTP-Referer'
                header_name = key[len("header_") :].replace("_", "-").title()
                # 同样解析环境变量
                self.custom_headers[header_name] = os.path.expandvars(value)

        # 初始化速率限制器
        self.rate_limit_count = provider_config.getint(
            "rate_limit_count", fallback=default_config.getint("rate_limit_count", 0)
        )
        self.rate_limit_period = provider_config.getint(
            "rate_limit_period_seconds",
            fallback=default_config.getint("rate_limit_period_seconds", 60),
        )

        if self.rate_limit_count > 0:
            # 使用 deque 存储最近的请求时间戳
            self.request_timestamps = collections.deque()
            # 确保在多线程环境下对 deque 的操作是安全的
            self.rate_limit_lock = threading.Lock()
            print(
                f"[{self.provider_name}] 已启用速率限制: 每 {self.rate_limit_period} 秒最多 {self.rate_limit_count} 次请求。"
            )
        else:
            print(f"[{self.provider_name}] 未启用速率限制。")

    def _wait_for_rate_limit(self):
        """如果达到速率限制，则阻塞并等待。"""
        if self.rate_limit_count <= 0:
            return  # 未启用速率限制

        with self.rate_limit_lock:
            current_time = time.time()

            # 1. 移除时间窗口之外的旧时间戳
            while (
                self.request_timestamps
                and self.request_timestamps[0] < current_time - self.rate_limit_period
            ):
                self.request_timestamps.popleft()

            # 2. 检查是否已达到限制
            if len(self.request_timestamps) >= self.rate_limit_count:
                # 计算需要等待的时间
                wait_time = (
                    self.request_timestamps[0] + self.rate_limit_period - current_time
                )
                if wait_time > 0:
                    print(
                        f"[{self.provider_name}] 达到速率限制，等待 {wait_time:.2f} 秒..."
                    )
                    time.sleep(wait_time)

            # 3. 记录当前请求的时间戳
            self.request_timestamps.append(time.time())

    def _build_headers(self):
        """构建请求头"""
        headers = {"Content-Type": "application/json"}
        if self.api_key and self.api_key != "no-key-required":
            headers["Authorization"] = f"Bearer {self.api_key}"
        # 添加所有自定义头
        headers.update(self.custom_headers)
        return headers

    def _build_payload(self, prompt):
        """构建请求体"""
        messages = []
        if self.use_system_role:
            messages.append({"role": "system", "content": self.system_prompt})
            messages.append({"role": "user", "content": prompt})
        else:
            # 对于不支持 system 角色的模型，将 system prompt 手动加到 user prompt 前面
            full_prompt = f"{self.system_prompt}\n\n---\n\n{prompt}"
            messages.append({"role": "user", "content": full_prompt})

        return {"model": self.model, "messages": messages}

    def _parse_response(self, response_json):
        """默认的响应解析器，适用于OpenAI格式的API"""
        return response_json["choices"][0]["message"]["content"]

    def translate(self, sentence, target_word):
        """执行翻译的完整流程"""
        self._wait_for_rate_limit()
        prompt = f"翻译下面句子中的「{target_word}」：{sentence}"

        headers = self._build_headers()
        payload = self._build_payload(prompt)

        # 配置网络代理
        proxies = None
        if self.proxy:
            proxies = {"http": self.proxy, "https": self.proxy}

        try:
            response = requests.post(
                self.api_url, headers=headers, json=payload, proxies=proxies
            )
            response.raise_for_status()

            translated_content = self._parse_response(response.json())
            if len(translated_content) > 30:
                raise ValueError("翻译结果过长")
            return translated_content

        except requests.exceptions.RequestException as e:
            print(f"[{self.provider_name}] 调用 API 失败: {e}")
            raise
        except (KeyError, IndexError, ValueError) as e:
            print(f"[{self.provider_name}] 解析响应失败: {e}")
            raise


# ==============================================================================
# 2. 缓存系统 (已修改，不再管理连接)
# ==============================================================================
class TranslationCache:
    """
    翻译缓存类，不再管理数据库连接，而是从请求上下文中获取连接。
    """

    def _generate_key(self, sentence, target_word):
        key_string = f"{sentence}|{target_word}"
        return hashlib.md5(key_string.encode("utf-8")).hexdigest()

    def get(self, sentence, target_word):
        key = self._generate_key(sentence, target_word)
        cursor = get_db().cursor()
        cursor.execute(
            "SELECT translation FROM translation_cache WHERE key = ?", (key,)
        )
        row = cursor.fetchone()
        return row[0] if row else None

    def set(self, sentence, target_word, translation):
        key = self._generate_key(sentence, target_word)
        timestamp = int(time.time())
        db = get_db()
        cursor = db.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO translation_cache (key, sentence, target_word, translation, timestamp) VALUES (?, ?, ?, ?, ?)",
            (key, sentence, target_word, translation, timestamp),
        )
        db.commit()

    def increment_word_frequency(self, word):
        db = get_db()
        cursor = db.cursor()
        cursor.execute(
            "UPDATE word_frequency SET frequency = frequency + 1 WHERE word = ?",
            (word,),
        )
        if cursor.rowcount == 0:
            cursor.execute(
                "INSERT INTO word_frequency (word, frequency) VALUES (?, 1)", (word,)
            )
        db.commit()
        new_freq = self.get_word_frequency(word)
        print(f"词语 '{word}' 选择次数更新为: {new_freq}")

    def get_word_frequency(self, word):
        cursor = get_db().cursor()
        cursor.execute("SELECT frequency FROM word_frequency WHERE word = ?", (word,))
        row = cursor.fetchone()
        return row[0] if row else 0

    def weighted_choice(self, words):
        if not words:
            return None
        if len(words) == 1:
            return words[0]
        weights = [1.0 / (self.get_word_frequency(word) + 1) for word in words]
        return random.choices(words, weights=weights, k=1)[0]


# ==============================================================================
# 3. Flask 应用 (已修改)
# ==============================================================================

app = Flask(__name__)
CORS(app)


# 3. 注册一个函数，在每个请求结束后关闭数据库连接
@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()


# 全局变量
translation_cache = TranslationCache()  # 现在它只是一个纯粹的逻辑处理器
translation_provider = None


@app.route("/translate", methods=["POST"])
def translate_word():
    data = request.json
    if not data or "sentence" not in data:
        return jsonify({"error": "请输入有效的JSON，并包含 'sentence' 字段"}), 400

    context_sentence = data["sentence"]
    words = pseg.lcut(context_sentence)
    result = [
        word for word, flag in words if flag.startswith("n") or flag.startswith("v")
    ]
    if not result:
        return jsonify({"error": "句子中未找到可翻译的名词或动词"}), 404

    target_word = translation_cache.weighted_choice(result)
    translation_cache.increment_word_frequency(target_word)

    cached = translation_cache.get(context_sentence, target_word)
    if cached:
        print(f"从缓存命中: {target_word} -> {cached}")
        return jsonify(
            {"target_word": target_word, "translation": cached, "from_cache": True}
        )

    try:
        print(f"通过 [{translation_provider.provider_name}] API 翻译: {target_word}")
        translated_content = translation_provider.translate(
            context_sentence, target_word
        )
        translation_cache.set(context_sentence, target_word, translated_content)
        print(f"翻译结果已缓存: {target_word} -> {translated_content}")
        return jsonify(
            {
                "target_word": target_word,
                "translation": translated_content,
                "from_cache": False,
            }
        )
    except Exception as e:
        return jsonify({"error": f"处理翻译请求时发生错误: {e}"}), 502


# ==============================================================================
# 4. 主程序入口
# ==============================================================================

if __name__ == "__main__":
    load_dotenv()
    print("已加载 .env 文件中的环境变量。")

    parser = argparse.ArgumentParser(description="启动 TransLens 后端翻译服务。")
    parser.add_argument(
        "--provider",
        type=str,
        help="指定要使用的 API 提供者 (必须在 config.ini 中定义)。",
    )
    args = parser.parse_args()

    config = ConfigParser()
    config.read("config.ini", encoding="utf-8")

    default_provider_from_config = os.path.expandvars(
        config.get("DEFAULT", "provider", fallback="local_llama")
    )
    provider_name = args.provider or default_provider_from_config

    print("-" * 50)
    print(f"准备启动服务，使用 API 提供者: '{provider_name}'")

    try:
        # 4. 初始化数据库 (如果文件不存在)
        if not os.path.exists(DATABASE_FILE):
            print(f"数据库文件 '{DATABASE_FILE}' 不存在，正在创建...")
            init_db()
        else:
            print(f"已连接到现有数据库: '{DATABASE_FILE}'")

        translation_provider = TranslationProvider(provider_name, config)
    except (ValueError, NoSectionError, NoOptionError) as e:
        print(f"\n[错误] 初始化提供者失败: {e}")
        print("请检查您的命令行参数和 config.ini 文件是否正确。\n")
        exit(1)

    print("-" * 50)
    app.run(debug=True, port=5000)
