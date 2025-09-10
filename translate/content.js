// Chrome插件内容脚本 - v4.1 (修复拼写错误)

(function () {
    'use strict';

    console.log('[TransLens] 内容脚本已加载 (v4.1 - 可见性检查 + 请求取消)');

    // 创建一个 AbortController 实例
    let controller = new AbortController();

    // 监听 pagehide 事件
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

    /**
     * 检查一个元素是否对用户可见。
     * @param {HTMLElement} el - 要检查的元素。
     * @returns {boolean} - 如果元素可见则返回 true，否则返回 false。
     */
    function isElementVisible(el) {
        if (!el) return false;
        
        // 检查元素及其所有父元素是否有 display: none
        if (window.getComputedStyle(el).display === 'none') {
            return false;
        }
        // ==========================================================
        //  vvv  错误修正：getcomputedstyle -> getComputedStyle  vvv
        // ==========================================================
        if (window.getComputedStyle(el).visibility === 'hidden') {
            return false;
        }
        // ==========================================================
        
        // 检查元素的尺寸，没有尺寸的元素通常是不可见的
        if (el.offsetWidth === 0 && el.offsetHeight === 0) {
            return false;
        }
        // 检查元素的透明度
        if (window.getComputedStyle(el).opacity === '0') {
            return false;
        }

        // 递归检查父元素
        if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') {
             return false;
        }
        
        return true;
    }


    // 提取中文内容并进行翻译
    function extractAndTranslateChinese() {
        console.log('\n=== 开始提取可见的中文内容 ===');

        const chineseTexts = extractChineseTexts();
        console.log(`发现 ${chineseTexts.length} 个可见的、包含中文的文本节点`);

        if (chineseTexts.length === 0) {
            console.log('未发现可见的中文内容');
            return;
        }

        // 随机选择指定比例的中文句子
        const selectedTexts = randomSelectTexts(chineseTexts, 0.4);
        console.log(`随机选择了 ${selectedTexts.length} 个中文句子进行翻译：`);

        translateSelectedTexts(selectedTexts);
    }

    // 提取所有包含中文的文本节点
    function extractChineseTexts() {
        const chineseRegex = /[\u4e00-\u9fff]/;
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
                const text = node.textContent.trim();
                if (text.length < 2 || !chineseRegex.test(text)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let textNode;
        while (textNode = walker.nextNode()) {
            textNode.parentElement.setAttribute(processedMark, 'true');
            chineseTexts.push({
                node: textNode,
                text: textNode.textContent.trim(),
                parent: textNode.parentElement
            });
        }
        return chineseTexts;
    }

    // 随机选择指定比例的文本
    function randomSelectTexts(texts, percentage) {
        const count = Math.max(1, Math.floor(texts.length * percentage));
        return [...texts].sort(() => 0.5 - Math.random()).slice(0, count);
    }

    // 对选中的文本进行翻译 (并发请求，渐进式渲染DOM)
    function translateSelectedTexts(selectedTexts) {
        console.log('\n=== 开始并发翻译，并渐进式渲染标注 ===');
        selectedTexts.forEach(textData => {
            (async () => {
                try {
                    const result = await callTranslateAPI(textData.text);
                    if (result && result.target_word && result.translation) {
                        annotateWordInText(textData, result.target_word, result.translation);
                    }
                } catch (error) {
                    if (error.name === 'AbortError') {
                        console.log(`  [已取消] 句子 "${textData.text}" 的翻译请求已被用户导航操作取消。`);
                    } else {
                        console.error(`  [失败] 句子: "${textData.text}", 错误:`, error);
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
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    }

    // 在文本节点中的目标词汇后添加英文标注
    function annotateWordInText(textData, targetWord, translation) {
        const parent = textData.parent;
        if (!parent || !document.body.contains(parent)) return;

        const originalText = textData.node.textContent;
        // 使用RegExp来替换所有出现的目标词，避免只替换第一个
        const targetWordRegex = new RegExp(targetWord, 'g');
        if (originalText.includes(targetWord)) {
             // 替换innerHTML可能会破坏事件监听器，但对于简单文本标注是可接受的
            const styledAnnotation = `<span style="color: #ff6b35; font-weight: bold; background-color: #fff3cd; padding: 1px 4px; border-radius: 3px; font-size: 0.85em; margin-left: 2px;">【${translation}】</span>`;
            parent.innerHTML = parent.innerHTML.replace(targetWordRegex, `${targetWord}${styledAnnotation}`);
        }
    }

    // 启动程序
    startObserver();

})();