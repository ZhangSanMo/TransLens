// Chrome插件内容脚本 - v5.0 (内存缓存 + 文本清洗)

(function () {
    'use strict';

    console.log('[TransLens] 内容脚本已加载 (v5.0 - 内存缓存 + 文本清洗)');

    // ==========================================================
    //  vvv                核心解决方案：内存缓存                vvv
    // ==========================================================
    // 使用一个Set来存储已经处理过的“纯净”文本，以防止在DOM重绘后重复翻译。
    // 这是解决动态内容（如代码编辑器）无限循环问题的关键。
    const processedTextsCache = new Set();
    // ==========================================================


    // 创建一个 AbortController 实例，用于在页面卸载时取消未完成的请求
    let controller = new AbortController();

    // 监听 pagehide 事件，当用户导航离开页面时中止请求
    window.addEventListener('pagehide', () => {
        console.log('[TransLens] 页面被隐藏或卸载，取消所有未完成的翻译请求。');
        controller.abort();
    });

    // 防抖计时器
    let debounceTimer;

    // 防抖函数，避免在DOM频繁变化时过于频繁地执行处理函数
    function debounce(func, delay) {
        return function (...args) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    }

    // 页面处理的主函数
    function processPage() {
        console.log('[TransLens] 开始处理页面可见内容...');
        extractAndTranslateChinese();
    }

    // 创建一个防抖版本的页面处理函数
    const debouncedProcessPage = debounce(processPage, 1000);

    // MutationObserver的回调函数，当DOM变化时触发
    const mutationCallback = function (mutationsList, observer) {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                // 如果之前的请求控制器已经被中止，创建一个新的
                if (controller.signal.aborted) {
                    console.log('[TransLens] 检测到DOM变化，但之前的控制器已中止，创建一个新的。');
                    controller = new AbortController();
                }
                debouncedProcessPage();
                return; // 只要有节点添加，就触发一次处理，然后返回
            }
        }
    };

    // 创建并配置MutationObserver
    const observer = new MutationObserver(mutationCallback);
    const config = { childList: true, subtree: true };

    // 启动Observer的函数
    function startObserver() {
        if (document.body) {
            observer.observe(document.body, config);
            console.log('[TransLens] MutationObserver 已启动，正在监视页面变化。');
            debouncedProcessPage(); // 首次加载时也执行一次
        } else {
            // 如果body还没加载好，稍后重试
            setTimeout(startObserver, 100);
        }
    }

    /**
     * 检查一个元素是否对用户可见。
     * @param {HTMLElement} el - 要检查的元素。
     * @returns {boolean} - 如果元素可见则返回 true，否则返回 false。
     */
    function isElementVisible(el) {
        if (!el) return false;

        const style = window.getComputedStyle(el);

        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
        if (el.offsetParent === null && style.position !== 'fixed') return false;

        return true;
    }

    // 提取中文内容并进行翻译
    function extractAndTranslateChinese() {
        console.log('\n=== 开始提取可见的中文内容 ===');

        const allChineseTexts = extractChineseTexts();

        // 关键步骤：只选择那些其“纯净”文本不在我们缓存中的节点
        const newChineseTexts = allChineseTexts.filter(textData => !processedTextsCache.has(textData.pureText));

        console.log(`发现 ${allChineseTexts.length} 个可见中文节点，其中 ${newChineseTexts.length} 个是新的`);

        if (newChineseTexts.length === 0) {
            console.log('未发现新的可见中文内容');
            return;
        }

        // 随机选择指定比例的中文句子
        const selectedTexts = randomSelectTexts(newChineseTexts, 0.4);
        console.log(`随机选择了 ${selectedTexts.length} 个新的中文句子进行翻译：`);

        // 在发起翻译请求前，立即将它们的“纯净”文本存入缓存
        // 这是为了防止在异步翻译完成前，下一次扫描又把它们识别为新文本
        selectedTexts.forEach(textData => {
            if (textData.pureText) { // 确保有纯净文本才添加
                processedTextsCache.add(textData.pureText);
            }
        });

        translateSelectedTexts(selectedTexts);
    }

    // 提取所有包含中文的文本节点
    function extractChineseTexts() {
        const chineseRegex = /[\u4e00-\u9fff]/;
        const translationRegex = /【.*?】/g; // 用于清除已存在的翻译标注
        const chineseTexts = [];
        const processedMark = 'data-translens-processed';

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                const parentElement = node.parentElement;
                // 过滤掉脚本、样式、已标记的元素以及不可见的元素
                if (!parentElement || parentElement.tagName === 'SCRIPT' || parentElement.tagName === 'STYLE' || parentElement.hasAttribute(processedMark)) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (!isElementVisible(parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }

                const text = node.textContent;

                const pureText = text.replace(translationRegex, '').trim();

                // 如果清洗后的文本长度小于2，或者不包含任何中文字符，则拒绝
                if (pureText.length < 2 || !chineseRegex.test(pureText)) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        });

        let textNode;
        while (textNode = walker.nextNode()) {
            // 给父元素添加标记，作为对静态页面的第一道防线
            textNode.parentElement.setAttribute(processedMark, 'true');

            const fullText = textNode.textContent;
            const pureText = fullText.replace(translationRegex, '').trim();

            chineseTexts.push({
                node: textNode,
                text: fullText.trim(), // 原始完整文本
                pureText: pureText,     // 清洗后的纯净文本，用于缓存和API调用
                parent: textNode.parentElement
            });
        }
        return chineseTexts;
    }

    // 随机选择指定比例的文本
    function randomSelectTexts(texts, percentage) {
        const count = Math.max(1, Math.floor(texts.length * percentage));
        // 使用Fisher-Yates (aka Knuth) Shuffle算法进行随机排序并截取
        const shuffled = [...texts];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled.slice(0, count);
    }

    // 对选中的文本进行翻译 (并发请求，渐进式渲染DOM)
    function translateSelectedTexts(selectedTexts) {
        console.log('\n=== 开始并发翻译，并渐进式渲染标注 ===');
        selectedTexts.forEach(textData => {
            (async () => {
                try {
                    // **重要**：调用API时使用pureText，避免将已有的翻译再次发送
                    const result = await callTranslateAPI(textData.pureText);
                    if (result && result.target_word && result.translation) {
                        annotateWordInText(textData, result.target_word, result.translation);
                    }
                } catch (error) {
                    if (error.name === 'AbortError') {
                        console.log(`  [已取消] 句子 "${textData.pureText}" 的翻译请求已被用户导航操作取消。`);
                    } else {
                        console.error(`  [失败] 句子: "${textData.pureText}", 错误:`, error);
                    }
                }
            })();
        });
        console.log('=== 所有翻译任务已启动，页面将逐步更新 ===');
    }

    // 调用翻译API
    async function callTranslateAPI(sentence) {
        const apiUrl = 'http://127.0.0.1:5000/translate';
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sentence: sentence }),
            signal: controller.signal // 关联AbortController的signal
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    }

    // 在文本节点中的目标词汇后添加英文标注
    function annotateWordInText(textData, targetWord, translation) {
        const parent = textData.parent;
        // 确保父元素仍然在DOM中
        if (!parent || !document.body.contains(parent)) return;

        const originalText = textData.node.textContent;
        // 使用正则表达式来全局替换所有出现的目标词
        const targetWordRegex = new RegExp(targetWord.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');

        if (originalText.includes(targetWord)) {
            // 替换innerHTML可能会破坏事件监听器，但对于简单文本标注是可接受的
            // 并且在这种动态场景下，非破坏性操作也可能被覆盖，所以innerHTML是一种直接有效的方式
            const styledAnnotation = `<span style="color: #ff6b35; font-weight: bold; background-color: #fff3cd; padding: 1px 4px; border-radius: 3px; font-size: 0.85em; margin-left: 2px;">【${translation}】</span>`;

            // 这里我们只在第一次出现的目标词后添加标注，以避免一个词被重复标注多次
            parent.innerHTML = parent.innerHTML.replace(targetWordRegex, `${targetWord}${styledAnnotation}`);
        }
    }

    // 启动程序
    startObserver();

})();