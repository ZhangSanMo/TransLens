// Chrome插件内容脚本 - v5.1 (修复缓存时机 + 安全替换)

(function () {
    'use strict';

    console.log('[TransLens] 内容脚本已加载 (v5.1 - 修复缓存时机)');

    // 使用一个Set来存储已经处理过的“纯净”文本，以防止在DOM重绘后重复翻译。
    const processedTextsCache = new Set();

    // 创建一个 AbortController 实例，用于在页面卸载时取消未完成的请求
    let controller = new AbortController();

    window.addEventListener('pagehide', () => {
        console.log('[TransLens] 页面被隐藏或卸载，取消所有未完成的翻译请求。');
        controller.abort();
    });

    let debounceTimer;

    function debounce(func, delay) {
        return function (...args) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    }

    function processPage() {
        console.log('[TransLens] 开始处理页面可见内容...');
        extractAndTranslateChinese();
    }

    const debouncedProcessPage = debounce(processPage, 1000);

    const mutationCallback = function (mutationsList, observer) {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                if (controller.signal.aborted) {
                    console.log('[TransLens] 检测到DOM变化，但之前的控制器已中止，创建一个新的。');
                    controller = new AbortController();
                }
                debouncedProcessPage();
                return;
            }
        }
    };

    const observer = new MutationObserver(mutationCallback);
    const config = { childList: true, subtree: true };

    function startObserver() {
        if (document.body) {
            observer.observe(document.body, config);
            console.log('[TransLens] MutationObserver 已启动，正在监视页面变化。');
            debouncedProcessPage();
        } else {
            setTimeout(startObserver, 100);
        }
    }

    function isElementVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
        if (el.offsetParent === null && style.position !== 'fixed') return false;
        return true;
    }

    function extractAndTranslateChinese() {
        console.log('\n=== 开始提取可见的中文内容 ===');

        const allChineseTexts = extractChineseTexts();
        const newChineseTexts = allChineseTexts.filter(textData => !processedTextsCache.has(textData.pureText));

        console.log(`发现 ${allChineseTexts.length} 个可见中文节点，其中 ${newChineseTexts.length} 个是新的`);

        if (newChineseTexts.length === 0) {
            console.log('未发现新的可见中文内容');
            return;
        }

        // ==========================================================
        //  vvv                核心逻辑修正                 vvv
        // ==========================================================
        // 立即缓存所有新发现的纯净文本，无论它们本次是否被选中翻译。
        // 这可以防止未被选中的文本在下一次扫描中被误认为“新”文本。
        newChineseTexts.forEach(textData => {
            if (textData.pureText) {
                processedTextsCache.add(textData.pureText);
            }
        });
        // ==========================================================

        // 然后，从这些新文本中，随机选择一部分进行翻译
        const selectedTexts = randomSelectTexts(newChineseTexts, 0.4);
        console.log(`随机选择了 ${selectedTexts.length} 个新的中文句子进行翻译 (从 ${newChineseTexts.length} 个新发现的文本中)`);

        translateSelectedTexts(selectedTexts);
    }

    function extractChineseTexts() {
        const chineseRegex = /[\u4e00-\u9fff]/;
        const translationRegex = /【.*?】/g;
        const chineseTexts = [];
        const processedMark = 'data-translens-processed';

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                const parentElement = node.parentElement;
                if (!parentElement || parentElement.tagName === 'SCRIPT' || parentElement.tagName === 'STYLE' || parentElement.hasAttribute(processedMark)) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (!isElementVisible(parentElement)) {
                    return NodeFilter.FILTER_REJECT;
                }

                const text = node.textContent;
                const pureText = text.replace(translationRegex, '').trim();

                if (pureText.length < 2 || !chineseRegex.test(pureText)) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        });

        let textNode;
        while (textNode = walker.nextNode()) {
            textNode.parentElement.setAttribute(processedMark, 'true');
            const fullText = textNode.textContent;
            const pureText = fullText.replace(translationRegex, '').trim();
            chineseTexts.push({
                node: textNode,
                text: fullText.trim(),
                pureText: pureText,
                parent: textNode.parentElement
            });
        }
        return chineseTexts;
    }

    function randomSelectTexts(texts, percentage) {
        const count = Math.max(1, Math.floor(texts.length * percentage));
        const shuffled = [...texts].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    function translateSelectedTexts(selectedTexts) {
        console.log('\n=== 开始并发翻译，并渐进式渲染标注 ===');
        selectedTexts.forEach(textData => {
            (async () => {
                try {
                    const result = await callTranslateAPI(textData.pureText);
                    if (result && result.target_word && result.translation) {
                        annotateWordInText(textData, result.target_word, result.translation);
                    }
                } catch (error) {
                    if (error.name === 'AbortError') {
                        console.log(`  [已取消] 句子 "${textData.pureText}" 的翻译请求已被取消。`);
                    } else {
                        console.error(`  [失败] 句子: "${textData.pureText}", 错误:`, error);
                    }
                }
            })();
        });
        console.log('=== 所有翻译任务已启动，页面将逐步更新 ===');
    }

    async function callTranslateAPI(sentence) {
        const apiUrl = 'http://127.0.0.1:5000/translate';
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sentence: sentence }),
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    }

    function annotateWordInText(textData, targetWord, translation) {
        const parent = textData.parent;
        if (!parent || !document.body.contains(parent)) return;

        // ==========================================================
        //  vvv                  安全替换                 vvv
        // ==========================================================
        // 构造一个安全的正则表达式，它会匹配目标词，但前提是这个词后面没有紧跟着一个【
        // (?!【) 就是一个负向先行断言，提供了这层保护
        const escapedTargetWord = targetWord.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const safeRegex = new RegExp(escapedTargetWord + '(?!【)', 'g');
        // ==========================================================

        if (safeRegex.test(parent.innerHTML)) {
            const styledAnnotation = `<span style="color: #ff6b35; font-weight: bold; background-color: #fff3cd; padding: 1px 4px; border-radius: 3px; font-size: 0.85em; margin-left: 2px;">【${translation}】</span>`;
            parent.innerHTML = parent.innerHTML.replace(safeRegex, `${targetWord}${styledAnnotation}`);
        }
    }

    startObserver();

})();