// Chrome插件内容脚本 - v2 (支持SPA动态内容)

(function () {
    'use strict';

    console.log('[TransLens] 内容脚本已加载 (v2 - SPA ready)');

    let debounceTimer;

    // 3. 防抖函数：在频繁触发时，只执行最后一次调用
    function debounce(func, delay) {
        return function (...args) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    }

    // 2. 核心翻译逻辑，封装成可重复调用的函数
    function processPage() {
        console.log('[TransLens] 开始处理页面内容...');
        extractAndTranslateChinese();
    }

    // 1. 创建一个防抖版的处理函数，延迟1秒执行
    const debouncedProcessPage = debounce(processPage, 1000);

    // 4. MutationObserver 的回调函数
    const mutationCallback = function (mutationsList, observer) {
        // 检查是否有节点添加或删除
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                // 发现内容变化，触发防抖处理
                console.log('[TransLens] 检测到DOM变化，准备处理...');
                debouncedProcessPage();
                return; // 只要有一次变化就足够了
            }
        }
    };

    // 5. 创建并配置 MutationObserver
    const observer = new MutationObserver(mutationCallback);
    const config = {
        childList: true, // 观察子节点的添加或删除
        subtree: true    // 观察所有后代节点
    };

    // 6. 启动观察
    // 我们需要等待 body 元素加载完成后再开始观察
    function startObserver() {
        if (document.body) {
            observer.observe(document.body, config);
            console.log('[TransLens] MutationObserver 已启动，正在监视页面变化。');

            // 首次加载时也执行一次翻译
            debouncedProcessPage();
        } else {
            // 如果 body 还没准备好，稍后再试
            setTimeout(startObserver, 100);
        }
    }

    // --------------------------------------------------------------------
    // 以下是原有的翻译和DOM处理函数，基本保持不变
    // --------------------------------------------------------------------

    // 提取中文内容并进行翻译
    function extractAndTranslateChinese() {
        console.log('\n=== 开始提取中文内容 ===');

        const chineseTexts = extractChineseTexts();
        console.log(`发现 ${chineseTexts.length} 个包含中文的文本节点`);

        if (chineseTexts.length === 0) {
            console.log('未发现中文内容');
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

    // 提取所有包含中文的文本节点
    function extractChineseTexts() {
        const chineseRegex = /[\u4e00-\u9fff]/;
        const chineseTexts = [];

        // 使用一个属性来标记已经处理过的节点，避免重复翻译
        const processedMark = 'data-translens-processed';

        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    // 忽略脚本和样式标签内的文本
                    const parentTag = node.parentNode.tagName;
                    if (parentTag === 'SCRIPT' || parentTag === 'STYLE') {
                        return NodeFilter.FILTER_REJECT;
                    }
                    // 检查节点是否已经被处理过
                    if (node.parentNode.hasAttribute(processedMark)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    const text = node.textContent.trim();
                    if (text.length < 2) return NodeFilter.FILTER_REJECT;
                    if (chineseRegex.test(text)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_REJECT;
                }
            }
        );

        let textNode;
        while (textNode = walker.nextNode()) {
            const text = textNode.textContent.trim();
            // 标记父节点为已处理
            textNode.parentNode.setAttribute(processedMark, 'true');
            chineseTexts.push({
                node: textNode,
                text: text,
                parent: textNode.parentNode
            });
        }

        return chineseTexts;
    }

    // 随机选择指定比例的文本
    function randomSelectTexts(texts, percentage) {
        const count = Math.max(1, Math.floor(texts.length * percentage));
        const shuffled = [...texts].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, count);
    }

    // 对选中的文本进行翻译 (并发请求，渐进式渲染DOM)
    function translateSelectedTexts(selectedTexts) {
        console.log('\n=== 开始并发翻译，并渐进式渲染标注 ===');

        // 1. 遍历所有选中的文本，为每一个都启动一个独立的翻译和标注流程
        selectedTexts.forEach(textData => {
            // 2. 使用一个立即执行的 async 函数来包裹每个请求
            // 这使得我们可以使用 await，但 forEach 循环本身不会被阻塞
            (async () => {
                try {
                    // 3. 发起API调用并等待其结果
                    const result = await callTranslateAPI(textData.text);

                    // 4. 一旦这个特定的请求完成，就立即尝试在DOM上进行标注
                    if (result && result.target_word && result.translation) {
                        console.log(`  [渲染] 词: "${result.target_word}" -> "${result.translation}" (缓存: ${result.from_cache})`);
                        annotateWordInText(textData, result.target_word, result.translation);
                    } else {
                        console.log(`  [警告] API未对 "${textData.text}" 返回有效结果`);
                    }

                } catch (error) {
                    // 如果单个请求失败，只记录错误，不影响其他正在进行的翻译
                    console.error(`  [失败] 句子: "${textData.text}", 错误:`, error);
                }
            })(); // <== 立即执行函数
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
        // 检查父元素是否还存在于DOM中
        if (!parent || !document.body.contains(parent)) {
            console.log('  [标注警告] 父元素已从DOM中移除，跳过标注。');
            return;
        }

        const originalText = textData.node.textContent;
        if (originalText.includes(targetWord)) {
            const styledAnnotation = `<span style="color: #ff6b35; font-weight: bold; background-color: #fff3cd; padding: 1px 4px; border-radius: 3px; font-size: 0.85em; margin-left: 2px;">【${translation}】</span>`;

            // 使用更安全的方式替换，只替换第一个匹配项，避免破坏HTML结构
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