// Chrome插件内容脚本 - v5.6 (最终悬浮按钮布局修复)

(function () {
    'use strict';

    console.log('[TransLens] 内容脚本已加载 (v5.6 - 最终悬浮按钮布局修复)');

    const processedTextsCache = new Set();
    let controller = new AbortController();

    window.addEventListener('pagehide', () => {
        console.log('[TransLens] 页面被隐藏或卸载，取消所有未完成的翻译请求。');
        controller.abort();
    });

    function handleMarkEasyClick(event) {
        const target = event.target;
        if (target.matches('.translens-mark-easy')) {
            const word = target.dataset.word;
            const annotationSpan = target.closest('.translens-annotation');

            if (word && annotationSpan) {
                console.log(`[TransLens] 用户标记单词 "${word}" 为 "我已学会"。`);
                annotationSpan.remove();
                markWordAsEasy(word);
            }
        }
    }

    async function markWordAsEasy(word) {
        try {
            const response = await fetch('http://127.0.0.1:5000/mark_easy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ word: word }),
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const result = await response.json();
            console.log(`[TransLens] 后端确认: "${result.word}" 将在 ${result.suppress_days} 天内不再翻译。`);
        } catch (error) {
            console.error(`[TransLens] 标记 "${word}" 为简单时出错:`, error);
        }
    }

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
            document.body.addEventListener('click', handleMarkEasyClick);
            observer.observe(document.body, config);
            console.log('[TransLens] MutationObserver 和点击监听器已启动。');
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
        newChineseTexts.forEach(textData => {
            if (textData.pureText) {
                processedTextsCache.add(textData.pureText);
            }
        });
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
                if (!parentElement || parentElement.tagName === 'SCRIPT' || parentElement.tagName === 'STYLE' || parentElement.hasAttribute(processedMark) || parentElement.closest('.translens-annotation')) {
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
            if (response.status === 404) {
                console.log(`[TransLens] 翻译跳过，因为所有候选词都被标记为“太简单”。`);
                return null;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    }

    function annotateWordInText(textData, targetWord, translation) {
        const parent = textData.parent;
        if (!parent || !document.body.contains(parent)) return;

        const escapedTargetWord = targetWord.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const safeRegex = new RegExp(escapedTargetWord + '(?!【)', 'g');

        // ==========================================================
        //  vvv                最终布局修复                 vvv
        // ==========================================================

        // 1. 定义绝对定位的按钮。
        //    关键点: `left: 100%` 将按钮的左边缘对齐到父容器的右边缘。
        //    这样它就完全在父容器的外部，不影响其尺寸。
        const actionButton = `
            <span class="translens-mark-easy translens-action-btn" data-word="${targetWord}" title="我已学会"
                  style="position: absolute; left: 100%; top: 50%; transform: translateY(-50%);
                         margin-left: 4px; line-height: 1; display: inline-flex; align-items: center; justify-content: center;
                         cursor: pointer; font-weight: bold; padding: 2px 4px; font-family: sans-serif;
                         color: #888; opacity: 0; transition: opacity 0.2s ease-in-out; border-radius: 3px; background: #eee;">
                &check;
            </span>`.replace(/\s\s+/g, ' ');

        // 2. 定义相对定位的父容器。
        //    关键点: 移除了 `padding-right`。现在的 padding 是对称的，不受按钮影响。
        const styledAnnotation = `
            <span class="translens-annotation"
                  style="position: relative; color: #ff6b35; font-weight: bold; background-color: #fff3cd;
                         padding: 1px 4px; border-radius: 3px; font-size: 0.85em; margin-left: 2px;"
                  onmouseover="this.querySelector('.translens-action-btn').style.opacity = '1'"
                  onmouseout="this.querySelector('.translens-action-btn').style.opacity = '0'">
                【${translation}】${actionButton}
            </span>`.replace(/\s\s+/g, ' ');
        // ==========================================================

        if (safeRegex.test(parent.innerHTML)) {
            parent.innerHTML = parent.innerHTML.replace(safeRegex, `${targetWord}${styledAnnotation}`);
        }
    }

    startObserver();

})();