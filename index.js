/**
 * Text Colorizer 文字着色 —— SillyTavern UI Extension
 *
 * 为聊天消息中的四类文本提供纯色 / 静态循环渐变着色：
 *   main       主要文本（普通叙述）
 *   italic     斜体文本（em / i）
 *   underline  下划线文本（u / ins）
 *   quote      引用文本（blockquote / q，含双引号对话）
 *
 * 渐变规则：静态循环渐变，默认每 30 个字走完一遍色标循环（可在面板调整），不动画。
 */

const MODULE_NAME = 'st_text_colorizer';

const context = SillyTavern.getContext();
const {
    extensionSettings,
    saveSettingsDebounced,
    eventSource,
    event_types,
} = context;

/* ------------------------------------------------------------------ */
/* 规则元数据                                                          */
/* ------------------------------------------------------------------ */

const RULE_META = [
    { key: 'main', label: '主要文本', hint: '普通叙述与旁白' },
    { key: 'italic', label: '斜体文本', hint: '*斜体* 心理活动 / 补充说明' },
    { key: 'underline', label: '下划线文本', hint: '++下划线++ 强调内容' },
    { key: 'quote', label: '引用 / 对话', hint: '> 引用块 与 “双引号” 对话' },
];

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    // 全局默认模式：gradient（渐变优先，渐变色占主体） / solid（纯色优先）
    globalMode: 'gradient',
    // 静态循环渐变字数（每 N 个字走完一遍色标循环）
    cycleLength: 30,
    // 是否同时着色用户消息
    applyToUser: false,
    // 是否跳过代码块 / 行内代码
    skipCode: true,
    rules: {
        main: {
            mode: 'inherit',
            solid: '#e8e8ee',
            gradient: ['#f3a8ff', '#a9c4ff'],
        },
        italic: {
            mode: 'inherit',
            solid: '#86b8ff',
            gradient: ['#86b8ff', '#c6e7ff'],
        },
        underline: {
            mode: 'inherit',
            solid: '#ffd68a',
            gradient: ['#ffd68a', '#ff9eb5'],
        },
        quote: {
            mode: 'inherit',
            solid: '#d9d9e0',
            gradient: ['#f3a8ff', '#a9c4ff'],
        },
    },
});

/* 不参与着色的区域选择器 */
const SKIP_SELECTOR = [
    'pre', 'code', 'kbd', 'script', 'style', 'details', 'summary',
    '.mes_bias', '.mes_reasoning', '.mes_prompt', '.mes_actions',
    '.ch_name', '.timestamp', '.mes_timer', '.tokenCounterDisplay',
    '.mesIDDisplay', '.mes_file_name', '.mes_file_size',
    '.mes_img_container', '.mes_img_controls', '.swipe_container',
    '.mes_edit_block', '.edit_textarea', '.mes_bookmark', '.mes_title',
    '.mes_reasoning_header', '.toolCall', '.mes_tool_calls',
    '.mes_avatar', '.avatar',
].join(',');

let settings = null;

function loadSettings() {
    extensionSettings[MODULE_NAME] = SillyTavern.libs.lodash.merge(
        structuredClone(DEFAULT_SETTINGS),
        extensionSettings[MODULE_NAME] ?? {},
    );
    // 补齐新版本新增的规则字段，避免老配置缺键
    for (const meta of RULE_META) {
        if (!extensionSettings[MODULE_NAME].rules[meta.key]) {
            extensionSettings[MODULE_NAME].rules[meta.key] = structuredClone(DEFAULT_SETTINGS.rules[meta.key]);
        }
        for (const field of ['mode', 'solid', 'gradient']) {
            if (!Object.hasOwn(extensionSettings[MODULE_NAME].rules[meta.key], field)) {
                extensionSettings[MODULE_NAME].rules[meta.key][field] = structuredClone(DEFAULT_SETTINGS.rules[meta.key][field]);
            }
        }
        if (!Array.isArray(extensionSettings[MODULE_NAME].rules[meta.key].gradient) || extensionSettings[MODULE_NAME].rules[meta.key].gradient.length < 2) {
            extensionSettings[MODULE_NAME].rules[meta.key].gradient = structuredClone(DEFAULT_SETTINGS.rules[meta.key].gradient);
        }
    }
    settings = extensionSettings[MODULE_NAME];
    return settings;
}

function persistSettings() {
    saveSettingsDebounced();
}

/* ------------------------------------------------------------------ */
/* 颜色工具                                                            */
/* ------------------------------------------------------------------ */

function normalizeHex(hex) {
    if (typeof hex !== 'string') return null;
    let h = hex.trim().replace('#', '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) {
        h = h.split('').map((c) => c + c).join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return `#${h.toLowerCase()}`;
}

function hexToRgb(hex) {
    const h = normalizeHex(hex);
    if (!h) return [200, 200, 200];
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToCss([r, g, b]) {
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/** 多色标分段线性插值；t ∈ [0, 1)，末段自然回到色标起点，形成闭环循环。 */
function interpolateGradient(colors, t) {
    const valid = colors.map(normalizeHex).filter(Boolean);
    if (valid.length === 0) return 'inherit';
    if (valid.length === 1) return normalizeHex(valid[0]);
    const n = valid.length;
    const clamped = Math.min(Math.max(t, 0), 0.999999);
    const seg = clamped * n;
    const i = Math.floor(seg) % n;
    const j = (i + 1) % n;
    const local = seg - Math.floor(seg);
    const a = hexToRgb(valid[i]);
    const b = hexToRgb(valid[j]);
    return rgbToCss(a.map((v, k) => v + (b[k] - v) * local));
}

/* ------------------------------------------------------------------ */
/* 着色引擎                                                            */
/* ------------------------------------------------------------------ */

function resolveMode(rule) {
    return rule.mode === 'inherit' ? settings.globalMode : rule.mode;
}

/** 判断文本节点所属类别：quote > italic > underline > main（引用 / 对话优先于内联格式标签） */
function classifyTextNode(node, root) {
    let el = node.parentElement;
    while (el && el !== root) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'blockquote' || tag === 'q') return 'quote';
        if (tag === 'em' || tag === 'i') return 'italic';
        if (tag === 'u' || tag === 'ins') return 'underline';
        el = el.parentElement;
    }
    return 'main';
}

function isSkipped(node) {
    if (settings.skipCode && node.closest('pre, code, kbd')) return true;
    return Boolean(node.closest(SKIP_SELECTOR));
}

/** 移除本插件注入的着色 span，把文本还原为原始结构（幂等） */
function unwrapColorSpans(root) {
    if (!root) return;
    root.querySelectorAll('span.stcx').forEach((span) => {
        span.replaceWith(...span.childNodes);
    });
}

/** 对一个文本容器执行着色；返回处理过的节点数 */
function paintContainer(root) {
    if (!root) return 0;
    unwrapColorSpans(root);
    if (!settings.enabled) return 0;

    let pos = 0; // 容器内可见字符计数（渐变循环依据）
    const cycle = Math.max(2, Number(settings.cycleLength) || 30);
    let painted = 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_SKIP;
            if (isSkipped(node.parentElement)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
        const category = classifyTextNode(node, root);
        const rule = settings.rules[category];
        if (!rule) continue;
        const mode = resolveMode(rule);
        const text = node.nodeValue;

        if (mode === 'solid') {
            const span = document.createElement('span');
            span.className = 'stcx stcx-solid';
            const solid = normalizeHex(rule.solid);
            if (solid) span.style.color = solid;
            node.replaceWith(span);
            span.appendChild(node);
            pos += countVisibleChars(text);
            painted += 1;
            continue;
        }

        // 静态循环渐变：逐字符取色，不做任何动画
        const fragment = document.createDocumentFragment();
        for (const ch of text) {
            const visible = ch.trim().length > 0;
            const t = (pos % cycle) / cycle;
            const color = interpolateGradient(rule.gradient, t);
            const span = document.createElement('span');
            span.className = 'stcx stcx-grad';
            span.style.color = color;
            span.textContent = ch;
            fragment.appendChild(span);
            if (visible) pos += 1;
        }
        node.replaceWith(fragment);
        painted += 1;
    }

    return painted;
}

function countVisibleChars(text) {
    let n = 0;
    for (const ch of text) if (ch.trim().length > 0) n += 1;
    return n;
}

function shouldSkipMessage(mesEl) {
    if (!settings.enabled) return true;
    if (mesEl.getAttribute('is_system') === 'true') return true;
    if (mesEl.getAttribute('is_user') === 'true' && !settings.applyToUser) return true;
    return false;
}

function colorizeMessage(mesEl) {
    if (!mesEl) return;
    if (shouldSkipMessage(mesEl)) {
        const root = mesEl.querySelector('.mes_text');
        if (root) unwrapColorSpans(root);
        return;
    }
    const root = mesEl.querySelector('.mes_text');
    if (root) paintContainer(root);
}

function escapeAttr(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function colorizeMessageById(messageId) {
    if (messageId === undefined || messageId === null) return colorizeAllMessages();
    const mesEl = document.querySelector(`#chat .mes[mesid="${escapeAttr(messageId)}"]`);
    if (mesEl) colorizeMessage(mesEl);
}

function colorizeAllMessages() {
    document.querySelectorAll('#chat .mes').forEach((mesEl) => colorizeMessage(mesEl));
}

function restoreAllMessages() {
    document.querySelectorAll('#chat .mes .mes_text').forEach((root) => unwrapColorSpans(root));
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

let debounceTimer = null;
function scheduleRepaint(delay = 120) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        colorizeAllMessages();
        paintPreview();
    }, delay);
}

function onMessageRendered(messageId) {
    colorizeMessageById(messageId);
}

function onUserMessageRendered(messageId) {
    if (settings.applyToUser) colorizeMessageById(messageId);
}

function onStreamToken() {
    scheduleRepaint(150);
}

function onChatChanged() {
    requestAnimationFrame(() => scheduleRepaint(200));
}

function onEdited() { scheduleRepaint(60); }
function onSwiped() { scheduleRepaint(60); }
function onSent() { scheduleRepaint(120); }
function onReceived() { scheduleRepaint(120); }
function onEnded() { scheduleRepaint(80); }

function onAppReady() {
    loadSettings();
    mountPanel();
    scheduleRepaint(250);
}

function bindEvents() {
    if (!eventSource) return;
    unbindEvents(); // 幂等：先解绑再绑定，避免重复注册
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessageRendered);
    eventSource.on(event_types.MESSAGE_EDITED, onEdited);
    eventSource.on(event_types.MESSAGE_SWIPED, onSwiped);
    eventSource.on(event_types.MESSAGE_SENT, onSent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onReceived);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_ENDED, onEnded);
    eventSource.on(event_types.APP_READY, onAppReady);
}

function unbindEvents() {
    if (!eventSource) return;
    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.removeListener(event_types.USER_MESSAGE_RENDERED, onUserMessageRendered);
    eventSource.removeListener(event_types.MESSAGE_EDITED, onEdited);
    eventSource.removeListener(event_types.MESSAGE_SWIPED, onSwiped);
    eventSource.removeListener(event_types.MESSAGE_SENT, onSent);
    eventSource.removeListener(event_types.MESSAGE_RECEIVED, onReceived);
    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.GENERATION_ENDED, onEnded);
    eventSource.removeListener(event_types.APP_READY, onAppReady);
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                            */
/* ------------------------------------------------------------------ */

function buildPanelHtml() {
    const ruleCardsSolid = RULE_META.map((meta) => `
        <div class="stcx-card stcx-solid-card" data-rule="${meta.key}">
            <div class="stcx-card-head">
                <span class="stcx-card-title">${meta.label}</span>
                <span class="stcx-mode-pair">
                    <label class="stcx-mode">
                        <input type="radio" name="stcx_mode_${meta.key}" value="inherit"> <span>跟随全局</span>
                    </label>
                    <label class="stcx-mode">
                        <input type="radio" name="stcx_mode_${meta.key}" value="solid"> <span>使用纯色</span>
                    </label>
                </span>
            </div>
            <div class="stcx-card-hint">${meta.hint}</div>
            <div class="stcx-row stcx-swatch-row">
                <input type="color" id="stcx_${meta.key}_solid" class="stcx-color-input" value="#e8e8ee" data-rule="${meta.key}" data-field="solid">
                <span class="stcx-text-preview" id="stcx_${meta.key}_solid_preview">示例文字</span>
            </div>
        </div>`).join('');

    const ruleCardsGradient = RULE_META.map((meta) => `
        <div class="stcx-card stcx-grad-card" data-rule="${meta.key}">
            <div class="stcx-card-head">
                <span class="stcx-card-title">${meta.label} <em class="stcx-recommend">推荐</em></span>
                <label class="stcx-mode">
                    <input type="radio" name="stcx_mode_${meta.key}" value="gradient"> <span>使用渐变</span>
                </label>
            </div>
            <div class="stcx-card-hint">${meta.hint}</div>
            <div class="stcx-gradient-bar" id="stcx_${meta.key}_grad_bar"></div>
            <div class="stcx-colorlist" id="stcx_${meta.key}_grad_list"></div>
            <div class="stcx-row stcx-swatch-row">
                <button type="button" class="stcx-btn stcx-add-color" data-rule="${meta.key}">+ 添加颜色</button>
                <span class="stcx-text-preview stcx-grad-preview" id="stcx_${meta.key}_grad_preview">示例文字</span>
            </div>
        </div>`).join('');

    return `
    <div class="stcx-panel" id="st-colorizer-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Text Colorizer 文字着色</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stcx-global">
                    <label class="stcx-toggle-row">
                        <input type="checkbox" id="stcx_enabled">
                        <span>启用文字着色</span>
                    </label>
                    <div class="stcx-mode-group">
                        <span class="stcx-group-label">全局默认模式</span>
                        <label class="stcx-mode"><input type="radio" name="stcx_global_mode" value="gradient"> <span>渐变优先（渐变色占主体，推荐）</span></label>
                        <label class="stcx-mode"><input type="radio" name="stcx_global_mode" value="solid"> <span>纯色优先</span></label>
                    </div>
                    <div class="stcx-row stcx-global-row">
                        <label class="stcx-field"><span>渐变循环字数</span>
                            <input type="number" id="stcx_cycle" min="5" max="100" step="1">
                        </label>
                        <label class="stcx-toggle-row"><input type="checkbox" id="stcx_apply_user"> <span>同时着色用户消息</span></label>
                        <label class="stcx-toggle-row"><input type="checkbox" id="stcx_skip_code"> <span>跳过代码块 / 行内代码</span></label>
                    </div>
                </div>

                <div class="stcx-columns">
                    <section class="stcx-column stcx-column-solid">
                        <header class="stcx-column-header">
                            <span>纯色面板</span>
                        </header>
                        <div class="stcx-grid-cards">${ruleCardsSolid}</div>
                    </section>
                    <section class="stcx-column stcx-column-gradient">
                        <header class="stcx-column-header stcx-column-header-gradient">
                            <span>渐变面板（主体）</span>
                        </header>
                        <div class="stcx-grid-cards">${ruleCardsGradient}</div>
                    </section>
                </div>

                <div class="stcx-preview-box">
                    <div class="stcx-preview-title">实时预览</div>
                    <div id="stcx_preview" class="stcx-preview-body">
                        这是主要文本的示例叙述。<em>这是斜体补充说明。</em><u>这是下划线强调内容。</u>
                        <blockquote>这是一条引用块。</blockquote>
                        <q>“这是双引号内的对话内容。”</q>
                    </div>
                </div>

                <div class="stcx-actions">
                    <button type="button" class="stcx-btn" id="stcx_repaint">重新着色当前聊天</button>
                    <button type="button" class="stcx-btn stcx-btn-danger" id="stcx_reset">恢复默认配置</button>
                </div>
            </div>
        </div>
    </div>`;
}

function mountPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    if (document.getElementById('st-colorizer-panel')) return;
    host.insertAdjacentHTML('beforeend', buildPanelHtml());
    bindPanelControls();
    syncPanelFromSettings();
    paintPreview();
}

/* ---- 面板控件同步 ---- */

function syncPanelFromSettings() {
    const s = settings;
    const enabled = document.getElementById('stcx_enabled');
    if (enabled) enabled.checked = s.enabled;
    const cycle = document.getElementById('stcx_cycle');
    if (cycle) cycle.value = s.cycleLength;
    const applyUser = document.getElementById('stcx_apply_user');
    if (applyUser) applyUser.checked = s.applyToUser;
    const skipCode = document.getElementById('stcx_skip_code');
    if (skipCode) skipCode.checked = s.skipCode;

    document.querySelectorAll('input[name="stcx_global_mode"]').forEach((el) => {
        el.checked = el.value === s.globalMode;
    });

    for (const meta of RULE_META) {
        const rule = s.rules[meta.key];
        document.querySelectorAll(`input[name="stcx_mode_${meta.key}"]`).forEach((el) => {
            el.checked = el.value === rule.mode;
        });
        const solidInput = document.getElementById(`stcx_${meta.key}_solid`);
        if (solidInput) solidInput.value = normalizeHex(rule.solid) || '#e8e8ee';
        renderGradientEditor(meta.key);
    }
}

function renderGradientEditor(ruleKey) {
    const rule = settings.rules[ruleKey];
    const list = document.getElementById(`stcx_${ruleKey}_grad_list`);
    const bar = document.getElementById(`stcx_${ruleKey}_grad_bar`);
    if (!list || !bar) return;

    const colors = rule.gradient.map(normalizeHex).filter(Boolean);
    list.innerHTML = '';
    colors.forEach((hex, index) => {
        const row = document.createElement('div');
        row.className = 'stcx-color-row';
        row.innerHTML = `
            <input type="color" class="stcx-color-input" value="${hex}" data-rule="${ruleKey}" data-index="${index}">
            <span class="stcx-hex">${hex}</span>
            <button type="button" class="stcx-remove-color" data-rule="${ruleKey}" data-index="${index}" title="删除此颜色" ${colors.length <= 2 ? 'disabled' : ''}>×</button>`;
        list.appendChild(row);
    });

    const css = `linear-gradient(90deg, ${colors.join(', ')})`;
    bar.style.background = css;
    bar.style.opacity = resolveMode(rule) === 'gradient' ? '1' : '0.45';
}

function paintPreview() {
    const preview = document.getElementById('stcx_preview');
    if (preview) paintContainer(preview);
    // 更新纯色 / 渐变小预览文字颜色
    for (const meta of RULE_META) {
        const rule = settings.rules[meta.key];
        const solidPreview = document.getElementById(`stcx_${meta.key}_solid_preview`);
        if (solidPreview) solidPreview.style.color = normalizeHex(rule.solid) || 'inherit';
        const gradPreview = document.getElementById(`stcx_${meta.key}_grad_preview`);
        if (!gradPreview) continue;
        const colors = rule.gradient.map(normalizeHex).filter(Boolean);
        if (colors.length > 0) {
            gradPreview.style.background = `linear-gradient(90deg, ${colors.join(', ')})`;
            gradPreview.style.webkitBackgroundClip = 'text';
            gradPreview.style.backgroundClip = 'text';
            gradPreview.style.color = 'transparent';
        }
    }
}

/* ---- 面板事件 ---- */

function bindPanelControls() {
    const root = document.getElementById('st-colorizer-panel');
    if (!root) return;

    root.addEventListener('change', (ev) => {
        const el = ev.target;

        if (el.id === 'stcx_enabled') {
            settings.enabled = el.checked;
            persistSettings();
            if (settings.enabled) colorizeAllMessages();
            else restoreAllMessages();
            paintPreview();
            return;
        }
        if (el.id === 'stcx_cycle') {
            settings.cycleLength = Math.min(100, Math.max(5, Number(el.value) || 30));
            el.value = settings.cycleLength;
            persistSettings();
            scheduleRepaint(60);
            return;
        }
        if (el.id === 'stcx_apply_user') {
            settings.applyToUser = el.checked;
            persistSettings();
            scheduleRepaint(60);
            return;
        }
        if (el.id === 'stcx_skip_code') {
            settings.skipCode = el.checked;
            persistSettings();
            scheduleRepaint(60);
            return;
        }
        if (el.name === 'stcx_global_mode') {
            settings.globalMode = el.value;
            persistSettings();
            scheduleRepaint(60);
            return;
        }
        if (el.name?.startsWith('stcx_mode_')) {
            const ruleKey = el.name.replace('stcx_mode_', '');
            settings.rules[ruleKey].mode = el.value;
            persistSettings();
            renderGradientEditor(ruleKey);
            scheduleRepaint(60);
            return;
        }
        if (el.dataset.field === 'solid' && el.dataset.rule) {
            settings.rules[el.dataset.rule].solid = el.value;
            persistSettings();
            renderGradientEditor(el.dataset.rule);
            scheduleRepaint(60);
            return;
        }
        if (el.classList.contains('stcx-color-input') && el.dataset.index !== undefined) {
            settings.rules[el.dataset.rule].gradient[Number(el.dataset.index)] = el.value;
            persistSettings();
            renderGradientEditor(el.dataset.rule);
            scheduleRepaint(60);
            return;
        }
    });

    root.addEventListener('input', (ev) => {
        const el = ev.target;
        if (el.dataset.field === 'solid' && el.dataset.rule) {
            settings.rules[el.dataset.rule].solid = el.value;
            paintPreview();
            return;
        }
        if (el.classList.contains('stcx-color-input') && el.dataset.index !== undefined) {
            settings.rules[el.dataset.rule].gradient[Number(el.dataset.index)] = el.value;
            renderGradientEditor(el.dataset.rule);
            paintPreview();
            return;
        }
    });

    root.addEventListener('click', (ev) => {
        const addBtn = ev.target.closest('.stcx-add-color');
        if (addBtn) {
            const rule = settings.rules[addBtn.dataset.rule];
            if (rule.gradient.length >= 5) {
                toastr?.warning('渐变最多支持 5 个颜色');
                return;
            }
            rule.gradient.push(rule.gradient[rule.gradient.length - 1] || '#ffffff');
            persistSettings();
            renderGradientEditor(addBtn.dataset.rule);
            scheduleRepaint(60);
            return;
        }
        const removeBtn = ev.target.closest('.stcx-remove-color');
        if (removeBtn && !removeBtn.disabled) {
            const rule = settings.rules[removeBtn.dataset.rule];
            rule.gradient.splice(Number(removeBtn.dataset.index), 1);
            persistSettings();
            renderGradientEditor(removeBtn.dataset.rule);
            scheduleRepaint(60);
            return;
        }
        if (ev.target.closest('#stcx_repaint')) {
            colorizeAllMessages();
            paintPreview();
            toastr?.success('已重新着色当前聊天');
            return;
        }
        if (ev.target.closest('#stcx_reset')) {
            if (!confirm('确定恢复默认配置？当前颜色设置将被重置。')) return;
            extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
            settings = extensionSettings[MODULE_NAME];
            persistSettings();
            syncPanelFromSettings();
            colorizeAllMessages();
            paintPreview();
            toastr?.success('已恢复默认配置');
        }
    });
}

/* ------------------------------------------------------------------ */
/* 生命周期 hooks                                                      */
/* ------------------------------------------------------------------ */

export async function onActivate() {
    loadSettings();
    bindEvents();
}

export async function onEnable() {
    loadSettings();
    mountPanel();
    colorizeAllMessages();
}

export async function onDisable() {
    restoreAllMessages();
    unbindEvents();
}

/* 兜底初始化：APP_READY 后挂载面板并重绘一次 */
if (eventSource && event_types) {
    bindEvents();
}
