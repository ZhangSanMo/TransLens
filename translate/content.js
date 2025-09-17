// Chrome插件内容脚本 - v5.4 (交互式悬浮确认框)

(function () {
    'use strict';

    console.log('[TransLens] 内容脚本已加载 (v5.4 - 交互式悬浮确认框)');

    // ==========================================================
    //  vvv         悬浮卡片 & 全局变量设置         vvv
    // ==========================================================
    let hoverCard;                // 悬浮卡片的DOM引用
    let currentAnnotation = null; // 当前正在悬浮的标注
    let hideCardTimer = null;     // 用于延迟隐藏卡片的计时器
    const processedTextsCache = new Set();
    let controller = new AbortController();

    window.addEventListener('pagehide', () => {
        console.log('[TransLens] 页面被隐藏或卸载，取消所有未完成的翻译请求。');
        controller.abort();
    });
    
    /**
     * 创建并注入悬浮卡片的CSS样式和HTML结构
     */
    function initHoverCard() {
        // 1. 注入CSS
        const styles = `
            .translens-hover-card {
                position: absolute;
                z-index: 999999;
                background-color: #333;
                color: white;
                border-radius: 6px;
                padding: 10px 15px;
                font-family: Arial, sans-serif;
                font-size: 14px;
                line-height: 1.4;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                display: none;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
                width: auto;
                max-width: 250px;
                text-align: left;
            }
            .translens-hover-card .original-word {
                font-weight: bold;
                font-size: 1.1em;
                margin-bottom: 4px;
            }
            .translens-hover-card .translation-text {
                color: #ddd;
            }
            .translens-hover-card .confirm-button {
                background-color: #007bff;
                color: white;
                border: none;
                padding: 5px 12px;
                border-radius: 4px;
                cursor: pointer;
                margin-top: 10px;
                font-weight: bold;
                display: block;
                width: 100%;
                text-align: center;
            }
            .translens-hover-card .confirm-button:hover {
                background-color: #0056b3;
            }
        `;
        const styleSheet = document.createElement("style");
        styleSheet.innerText = styles;
        document.head.appendChild(styleSheet);

        // 2. 创建悬浮卡片的HTML结构 (单例模式)
        hoverCard = document.createElement('div');
        hoverCard.className = 'translens-hover-card';
        document.body.appendChild(hoverCard);
        
        // 3. 为卡片本身也添加悬浮/移出逻辑，防止在移向按钮时卡片消失
        hoverCard.addEventListener('mouseenter', () => clearTimeout(hideCardTimer));
        hoverCard.addEventListener('mouseleave', hideHoverCard);
    }
    
    /**
     * 显示并定位悬浮卡片
     * @param {HTMLElement} targetAnnotation - 用户悬浮的标注元素
     */
    function showHoverCard(targetAnnotation) {
        clearTimeout(hideCardTimer); // 取消可能存在的隐藏计时器
        
        currentAnnotation = targetAnnotation;
        const word = targetAnnotation.dataset.word;
        const translation = targetAnnotation.dataset.translation;

        // 填充内容
        hoverCard.innerHTML = `
            <div class="original-word">${word}</div>
            <div class="translation-text">【${translation}】</div>
            <button class="confirm-button">Got it ✓</button>
        `;

        // 绑定按钮点击事件
        hoverCard.querySelector('.confirm-button').addEventListener('click', () => {
            console.log(`[TransLens] 用户确认 "${word}" 为 "太简单了"。`);
            markWordAsEasy(word);
            currentAnnotation.remove(); // 移除页面上的标注
            hideHoverCard();
        });

        // 定位
        const rect = targetAnnotation.getBoundingClientRect();
        hoverCard.style.display = 'block';
        hoverCard.style.left = `${window.scrollX + rect.left}px`;
        hoverCard.style.top = `${window.scrollY + rect.bottom + 5}px`; // 在标注下方5px
        
        // 渐显
        setTimeout(() => hoverCard.style.opacity = '1', 10);
    }

    /**
     * 隐藏悬浮卡片
     */
    function hideHoverCard() {
        hoverCard.style.opacity = '0';
        // 在动画结束后再隐藏，防止突然消失
        setTimeout(() => {
            if (hoverCard.style.opacity === '0') {
                 hoverCard.style.display = 'none';
                 currentAnnotation = null;
            }
        }, 200);
    }


    /**
     * 调用后端API将单词标记为简单
     * @param {string} word 
     */
    async function markWordAsEasy(word) {
        try {
            const response = await fetch('http://127.0.0.1:5000/mark_easy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ word: word }),
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const result = await response.json();
            console.log(`[TransLens] 后端确认: "${result.word}" 将在 ${result.suppress_days} 天内不再翻译。`);
        } catch (error) {
            console.error(`[TransLens] 标记 "${word}" 为简单时出错:`, error);
        }
    }
    
    // ==========================================================
    //          vvv  原有的页面处理逻辑 (有微小改动)  vvv
    // ==========================================================

    let debounceTimer;
    function debounce(func, delay) { /* ... (no changes) ... */
        return function (...args) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    }
    function processPage() { /* ... (no changes) ... */
        console.log('[TransLens] 开始处理页面可见内容...');
        extractAndTranslateChinese();
    }
    const debouncedProcessPage = debounce(processPage, 1000);

    const mutationCallback = function (mutationsList, observer) { /* ... (no changes) ... */
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
            // 初始化悬浮卡片
            initHoverCard();

            // 使用事件委托处理所有标注的悬浮事件
            document.body.addEventListener('mouseover', (event) => {
                const annotation = event.target.closest('.translens-annotation');
                if (annotation && annotation !== currentAnnotation) {
                    showHoverCard(annotation);
                }
            });
            
            document.body.addEventListener('mouseout', (event) => {
                const annotation = event.target.closest('.translens-annotation');
                if (annotation) {
                    // 延迟隐藏，给用户移动到卡片上的时间
                    hideCardTimer = setTimeout(hideHoverCard, 300);
                }
            });

            observer.observe(document.body, config);
            console.log('[TransLens] MutationObserver 和悬浮监听器已启动。');
            debouncedProcessPage();
        } else {
            setTimeout(startObserver, 100);
        }
    }
    
    function isElementVisible(el) { /* ... (no changes) ... */
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
        if (el.offsetParent === null && style.position !== 'fixed') return false;
        return true;
    }
    function extractAndTranslateChinese() { /* ... (no changes) ... */
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
    function extractChineseTexts() { /* ... (no changes) ... */
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
    function randomSelectTexts(texts, percentage) { /* ... (no changes) ... */
        const count = Math.max(1, Math.floor(texts.length * percentage));
        const shuffled = [...texts].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }
    function translateSelectedTexts(selectedTexts) { /* ... (no changes) ... */
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
    async function callTranslateAPI(sentence) { /* ... (no changes) ... */
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
    
    /**
     * 修改此函数，为标注添加 data-* 属性，而不是按钮
     */
    function annotateWordInText(textData, targetWord, translation) {
        const parent = textData.parent;
        if (!parent || !document.body.contains(parent)) return;

        const escapedTargetWord = targetWord.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const safeRegex = new RegExp(escapedTargetWord + '(?!【)', 'g');
        
        // 核心改造：将单词和翻译存入data-*属性，用于悬浮卡片
        const styledAnnotation = `
            <span class="translens-annotation" 
                  data-word="${targetWord}" 
                  data-translation="${translation}"
                  style="color: #ff6b35; font-weight: bold; background-color: #fff3cd; padding: 1px 4px; border-radius: 3px; cursor: pointer;">
                【${translation}】
            </span>`;
        
        if (safeRegex.test(parent.innerHTML)) {
            parent.innerHTML = parent.innerHTML.replace(safeRegex, `${targetWord}${styledAnnotation}`);
        }
    }

    // 脚本的入口点
    startObserver();

})();