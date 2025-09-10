// Chrome插件内容脚本 - v3 (增加可见性检查)

(function () {
    'use strict';

    console.log('[TransLens] 内容脚本已加载 (v3 - 可见性检查)');

    let debounceTimer;

    // 防抖函数：在频繁触发时，只执行最后一次调用
    function debounce(func, delay) {
        return function (...args) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    }

    // 核心翻译逻辑，封装成可重复调用的函数
    function processPage() {
        console.log('[TransLens] 开始处理页面可见内容...');
        extractAndTranslateChinese();
    }

    // 创建一个防抖版的处理函数，延迟1秒执行
    const debouncedProcessPage = debounce(processPage, 1000);

    // MutationObserver 的回调函数
    const mutationCallback = function (mutationsList, observer) {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                console.log('[TransLens] 检测到DOM变化，准备处理...');
                debouncedProcessPage();
                return;
            }
        }
    };

    // 创建并配置 MutationObserver
    const observer = new MutationObserver(mutationCallback);
    const config = {
        childList: true,
        subtree: true
    };

    // 启动观察
    function startObserver() {
        if (document.body) {
            observer.observe(document.body, config);
            console.log('[TransLens] MutationObserver 已启动，正在监视页面变化。');
            debouncedProcessPage();
        } else {
            setTimeout(startObserver, 100);
        }
    }

    // ====================================================================
    // 核心改动部分
    // ====================================================================

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
        // 检查元素及其所有父元素是否有 visibility: hidden
        if (window.getComputedStyle(el).visibility === 'hidden') {
            return false;
        }
        // 检查元素的尺寸，没有尺寸的元素通常是不可见的
        if (el.offsetWidth === 0 && el.offsetHeight === 0) {
            return false;
        }
        // 检查元素的透明度
        if (window.getComputedStyle(el).opacity === '0') {
            return false;
        }

        // 递归检查父元素
        // 如果 offsetParent 为 null，表示元素或其祖先之一被设置为 display: none
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

        selectedTexts.forEach((textData, index) => {
            console.log(`${index + 1}. "${textData.text}"`);
        });

        translateSelectedTexts(selectedTexts);
    }

    // 提取所有包含中文的文本节点 (已更新过滤器)
    function extractChineseTexts() {
        const chineseRegex = /[\u4e00-\u9fff]/;
        const chineseTexts = [];

        const processedMark = 'data-translens-processed';

        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    const parentElement = node.parentElement;

                    // 基本的过滤条件
                    if (!parentElement || parentElement.tagName === 'SCRIPT' || parentElement.tagName === 'STYLE') {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (parentElement.hasAttribute(processedMark)) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // *** 新增的可见性检查 ***
                    if (!isElementVisible(parentElement)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    
                    const text = node.textContent.trim();
                    if (text.length < 2 || !chineseRegex.test(text)) {
                         return NodeFilter.FILTER_REJECT;
                    }
                    
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        let textNode;
        while (textNode = walker.nextNode()) {
            const text = textNode.textContent.trim();
            // 标记父节点为已处理
            textNode.parentElement.setAttribute(processedMark, 'true');
            chineseTexts.push({
                node: textNode,
                text: text,
                parent: textNode.parentElement
            });
        }
        return chineseTexts;
    }


    // ====================================================================
    // 以下函数保持不变
    // ====================================================================

    // 随机选择指定比例的文本
    function randomSelectTexts(texts, percentage) {
        const count = Math.max(1, Math.floor(texts.length * percentage));
        const shuffled = [...texts].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, count);
    }

    // 对选中的文本进行翻译 (并发请求，渐进式渲染DOM)
    function translateSelectedTexts(selectedTexts) {
        console.log('\n=== 开始并发翻译，并渐进式渲染标注 ===');

        selectedTexts.forEach(textData => {
            (async () => {
                try {
                    const result = await callTranslateAPI(textData.text);
                    if (result && result.target_word && result.translation) {
                        console.log(`  [渲染] 词: "${result.target_word}" -> "${result.translation}" (缓存: ${result.from_cache})`);
                        annotateWordInText(textData, result.target_word, result.translation);
                    } else {
                        console.log(`  [警告] API未对 "${textData.text}" 返回有效结果`);
                    }
                } catch (error) {
                    console.error(`  [失败] 句子: "${textData.text}", 错误:`, error);
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
            body: JSON.stringify({ sentence: sentence })
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    }

    // 在文本节点中的目标词汇后添加英文标注
    function annotateWordInText(textData, targetWord, translation) {
        const parent = textData.parent;
        if (!parent || !document.body.contains(parent)) {
            console.log('  [标注警告] 父元素已从DOM中移除，跳过标注。');
            return;
        }

        const originalText = textData.node.textContent;
        if (originalText.includes(targetWord)) {
            const styledAnnotation = `<span style="color: #ff6b35; font-weight: bold; background-color: #fff3cd; padding: 1px 4px; border-radius: 3px; font-size: 0.85em; margin-left: 2px;">【${translation}】</span>`;
            const newHTML = parent.innerHTML.replace(targetWord, `${targetWord}${styledAnnotation}`);
            parent.innerHTML = newHTML;
            console.log(`  [标注成功] 已在 "${targetWord}" 后添加标注。`);
        } else {
            console.log(`  [标注警告] 原文本中未找到目标词汇 "${targetWord}"`);
        }
    }

    // 启动程序
    startObserver();

})();