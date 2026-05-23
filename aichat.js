// ==UserScript==
// @name         AI 聊天题转互动测验 + 多 Prompt 管理
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  将规范题目转为可交互卡片，支持原文/渲染切换、多 Prompt 管理、粘贴发送、题库导出、Gitee 自动同步。兼容 DeepSeek / ChatGPT / 智谱清言。
// @match        https://chat.deepseek.com/*
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://chatglm.cn/*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const STORAGE_KEYS = {
    prompts: 'ds_prompt_list_v2',
    legacyPrompt: 'ds_keypoint_prompt',
    quizEnabled: 'ds_quiz_enabled_v2',
    quizRecords: 'ds_quiz_records_v1',
    questionBank: 'ds_question_bank_v1',
    geeToken: 'ds_gee_token_v1',
    geeRepo: 'ds_gee_repo_v1',
    geePath: 'ds_gee_path_v1',
    geeAutoSync: 'ds_gee_autosync_v1'
  };

  const SUPPORTED_TYPES = ['单选题', '多选题', '填空题', '简答题', '判断题'];
  const renderedBlocks = new WeakMap();
  let quizEnabled = localStorage.getItem(STORAGE_KEYS.quizEnabled) === '1';
  let observer = null;
  let scanTimer = null;
  let inputHidden = false;
  let hiddenInputTarget = null;
  let hiddenInputPreviousDisplay = '';
  let quizRecords = loadQuizRecords();

  const LEGACY_MAKE_QUIZ_PROMPT =
    '请基于以上内容生成一组测验题，严格使用下面格式，不要输出额外说明：\n\n' +
    '【单选题】题干\nA. 选项\nB. 选项\nC. 选项\nD. 选项\n答案：A\n解析：解析内容\n\n---\n\n' +
    '支持题型只使用【单选题】【多选题】【填空题】【简答题】【判断题】。每题必须包含“答案：”和“解析：”。';

  const DEFAULT_MAKE_QUIZ_PROMPT =
    '请根据以上学习内容生成一组可直接导入“互动测验/刷题系统”的题目。必须严格遵守以下格式要求：\n\n' +
    '1. 只输出题目文本，不要输出标题、说明、总结、寒暄、Markdown 代码块或任何额外内容。\n' +
    '2. 每道题必须以题型标签开头，题型只能使用：【单选题】【多选题】【填空题】【简答题】【判断题】。\n' +
    '3. 多道题之间用单独一行 --- 分隔。\n' +
    '4. 每道题都必须包含“答案：”和“解析：”，解析必须具体说明依据，不要写“暂无解析”。\n' +
    '5. 选择题必须提供 A-D 四个选项，每个选项独占一行，格式为“A. 内容”。单选题答案写一个字母，例如“答案：B”；多选题答案用英文逗号分隔并按字母顺序写，例如“答案：A,C,D”。\n' +
    '6. 填空题用 ___、（）或 ( ) 标记空白；多个空的答案用 | 分隔，例如“答案：第一个空|第二个空”。\n' +
    '7. 简答题的“答案：”写完整参考答案；必须额外提供“关键词：”行，关键词用 | 分隔，并放在“解析：”之前。\n' +
    '8. 判断题答案只能写“正确”或“错误”。\n' +
    '9. 题目应覆盖核心概念、关键公式、易错点和应用理解；如果原文信息不足，只生成能从原文明确推出的题目，不要编造事实。\n\n' +
    '输出模板如下：\n\n' +
    '【单选题】题干\n' +
    'A. 选项\n' +
    'B. 选项\n' +
    'C. 选项\n' +
    'D. 选项\n' +
    '答案：B\n' +
    '解析：说明为什么 B 正确，以及其他选项为什么不合适。\n\n' +
    '---\n\n' +
    '【多选题】题干\n' +
    'A. 选项\n' +
    'B. 选项\n' +
    'C. 选项\n' +
    'D. 选项\n' +
    '答案：A,C\n' +
    '解析：说明每个正确选项的依据，并指出错误选项的问题。\n\n' +
    '---\n\n' +
    '【填空题】题干包含___和___。\n' +
    '答案：答案1|答案2\n' +
    '解析：说明每个空的依据。\n\n' +
    '---\n\n' +
    '【简答题】题干\n' +
    '答案：完整参考答案。\n' +
    '关键词：关键词1|关键词2|关键词3\n' +
    '解析：说明答题要点和评分重点。\n\n' +
    '---\n\n' +
    '【判断题】题干\n' +
    '答案：正确\n' +
    '解析：说明判断依据。';

  const DEFAULT_PROMPTS = [
    {
      id: 'keypoints',
      name: '提取关键点',
      text:
        '请总结以上对话的核心信息与结论。要求：\n' +
        '- 语言简洁、准确，便于我复制后发给另一个 AI；\n' +
        '- 只保留关键事实、决策或待办事项；\n' +
        '- 如有不确定或信息缺失的地方，必须明确指出并询问补充，不要自行编造。'
    },
    {
      id: 'make-quiz',
      name: '生成测验题',
      text: DEFAULT_MAKE_QUIZ_PROMPT
    }
  ];

  function createId() {
    return `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeChoiceAnswer(value) {
    return String(value || '')
      .trim()
      .replace(/[，、;；\s]+/g, ',')
      .replace(/^,+|,+$/g, '')
      .toUpperCase()
      .split(',')
      .filter(Boolean)
      .sort()
      .join(',');
  }

  function normalizeTextAnswer(value) {
    return String(value || '').toLowerCase().replace(/\s/g, '');
  }

  function loadQuizRecords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.quizRecords);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function saveQuizRecords() {
    try {
      localStorage.setItem(STORAGE_KEYS.quizRecords, JSON.stringify(quizRecords));
    } catch (err) {
      const entries = Object.entries(quizRecords).sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')));
      quizRecords = Object.fromEntries(entries.slice(0, 500));
      try {
        localStorage.setItem(STORAGE_KEYS.quizRecords, JSON.stringify(quizRecords));
      } catch (err2) {}
    }
  }

  function loadQuestionBank() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.questionBank);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function saveQuestionBank(bank) {
    try {
      localStorage.setItem(STORAGE_KEYS.questionBank, JSON.stringify(bank));
    } catch (err) {
      const trimmed = bank.slice(-500);
      try { localStorage.setItem(STORAGE_KEYS.questionBank, JSON.stringify(trimmed)); } catch (err2) {}
    }
  }

  function addToQuestionBank(q) {
    const bank = loadQuestionBank();
    const key = getQuizRecordKey(q);
    const exists = bank.findIndex(item => getQuizRecordKey(item) === key);
    const entry = {
      type: q.type,
      stem: q.stem,
      options: q.options || [],
      answer: q.answer,
      analysis: q.analysis || '',
      keywords: q.keywords || '',
      savedAt: new Date().toISOString()
    };
    if (exists >= 0) {
      bank[exists] = entry;
    } else {
      bank.push(entry);
    }
    if (bank.length > 1000) {
      bank.splice(0, bank.length - 800);
    }
    saveQuestionBank(bank);
    // Auto-sync to Gitee if configured
    const cfg = getGiteeConfig();
    if (cfg.autoSync && cfg.token && cfg.repo) {
      syncToGitee(true);
    }
  }

  function getGiteeConfig() {
    return {
      token: localStorage.getItem(STORAGE_KEYS.geeToken) || '',
      repo: localStorage.getItem(STORAGE_KEYS.geeRepo) || '',
      path: localStorage.getItem(STORAGE_KEYS.geePath) || 'desktop-questions.json',
      autoSync: localStorage.getItem(STORAGE_KEYS.geeAutoSync) === '1'
    };
  }

  function saveGiteeConfig(cfg) {
    localStorage.setItem(STORAGE_KEYS.geeToken, cfg.token || '');
    localStorage.setItem(STORAGE_KEYS.geeRepo, cfg.repo || '');
    localStorage.setItem(STORAGE_KEYS.geePath, cfg.path || 'desktop-questions.json');
    localStorage.setItem(STORAGE_KEYS.geeAutoSync, cfg.autoSync ? '1' : '0');
  }

  async function syncToGitee(silent) {
    const cfg = getGiteeConfig();
    if (!cfg.token || !cfg.repo) {
      if (!silent) alert('请先配置 Gitee：点击 ⚙ 同步设置');
      return false;
    }
    const bank = loadQuestionBank();
    if (!bank.length) return false;

    try {
      const [owner, repo] = cfg.repo.split('/');
      const json = JSON.stringify(bank);
      const b64 = btoa(unescape(encodeURIComponent(json)));

      // Get existing file SHA
      let sha = '';
      try {
        const r = await fetch('https://gitee.com/api/v5/repos/' + owner + '/' + repo + '/contents/' + cfg.path + '?access_token=' + cfg.token);
        if (r.ok) { const d = await r.json(); sha = d.sha; }
      } catch (e) {}

      const method = sha ? 'PUT' : 'POST';
      const body = { access_token: cfg.token, message: '更新桌面题库 ' + new Date().toISOString().slice(0, 19), content: b64 };
      if (sha) body.sha = sha;

      const res = await fetch('https://gitee.com/api/v5/repos/' + owner + '/' + repo + '/contents/' + cfg.path, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        if (!silent) {
          const syncBtn = document.getElementById('ds-sync-status');
          if (syncBtn) { syncBtn.textContent = '☁'; syncBtn.title = '同步成功'; syncBtn.style.background = '#16a34a'; setTimeout(() => { syncBtn.textContent = '⚙'; syncBtn.title = '同步设置'; syncBtn.style.background = '#0f766e'; }, 2000); }
        }
        return true;
      } else {
        if (!silent) alert('Gitee 推送失败，请检查 Token 和仓库名');
        return false;
      }
    } catch (e) {
      if (!silent) alert('Gitee 推送出错: ' + e.message);
      return false;
    }
  }

  function formatQuestionForExport(q) {
    let text = '【' + q.type + '】' + q.stem + '\n';
    if (q.options && q.options.length) {
      q.options.forEach(opt => {
        text += opt.label + '. ' + opt.text + '\n';
      });
    }
    if (q.keywords) {
      text += '关键词：' + q.keywords + '\n';
    }
    text += '答案：' + q.answer + '\n';
    text += '解析：' + q.analysis;
    return text;
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  function getQuizRecordKey(q) {
    return 'q_' + hashString([location.hostname, q.type, q.stem, q.answer].join('\n'));
  }

  function getQuizRecord(q) {
    return quizRecords[getQuizRecordKey(q)] || null;
  }

  function setQuizRecord(q, patch) {
    const key = getQuizRecordKey(q);
    quizRecords[key] = {
      ...(quizRecords[key] || {}),
      type: q.type,
      stem: String(q.stem || '').slice(0, 300),
      correctAnswer: q.answer,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    if (Object.keys(quizRecords).length > 800) {
      const entries = Object.entries(quizRecords).sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')));
      quizRecords = Object.fromEntries(entries.slice(0, 600));
    }
    saveQuizRecords();
    return quizRecords[key];
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function multilineHtml(value) {
    return escapeHtml(value).replace(/\r?\n/g, '<br>');
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function buttonDisabled(btn) {
    return btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.dataset.disabled === 'true';
  }

  function findInputBox(includeHidden = false) {
    const selectors = [
      'textarea',
      'input[type="text"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'div[class*="chat-input"]',
      'div[class*="input-area"]'
    ];

    for (const selector of selectors) {
      const boxes = [...document.querySelectorAll(selector)].filter(box => {
        if (box.closest('#ds-prompt-dialog')) return false;
        return includeHidden || isVisible(box);
      });
      if (boxes.length) return boxes[boxes.length - 1];
    }
    return null;
  }

  function findInputContainer() {
    const input = findInputBox(true);
    if (!input) return null;
    return input.closest('form, div[class*="composer"], div[class*="input"], div.fixed, div.sticky') || input;
  }

  function setInputHidden(nextHidden) {
    const container = findInputContainer();
    if (!container) return false;

    if (hiddenInputTarget !== container) {
      hiddenInputTarget = container;
      hiddenInputPreviousDisplay = hiddenInputTarget.style.display || '';
    }

    inputHidden = nextHidden;
    hiddenInputTarget.style.display = inputHidden ? 'none' : hiddenInputPreviousDisplay;

    const btn = document.getElementById('ds-toggle-input-btn');
    if (btn) {
      btn.textContent = inputHidden ? '⌨' : '💬';
      btn.title = inputHidden ? '展开输入框' : '隐藏输入框';
      btn.style.background = inputHidden ? '#64748b' : '#4f46e5';
    }

    return true;
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      'button[title*="发送"]',
      'button[title*="Send"]',
      'button[class*="send"]',
      '[role="button"][aria-label*="发送"]',
      '[role="button"][aria-label*="Send"]'
    ];

    for (const selector of selectors) {
      const buttons = [...document.querySelectorAll(selector)].filter(btn => isVisible(btn) && !buttonDisabled(btn));
      if (buttons.length) return buttons[buttons.length - 1];
    }
    return null;
  }

  function dispatchTextEvents(inputBox) {
    inputBox.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: inputBox.value || inputBox.innerText || ''
    }));
    inputBox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setComposerText(inputBox, text) {
    inputBox.focus();

    if (inputBox.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(inputBox, text);
      else inputBox.value = text;
      dispatchTextEvents(inputBox);
      return;
    }

    if (inputBox.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(inputBox, text);
      else inputBox.value = text;
      dispatchTextEvents(inputBox);
      return;
    }

    if (inputBox.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      inputBox.textContent = '';
      range.selectNodeContents(inputBox);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      const inserted = document.execCommand && document.execCommand('insertText', false, text);
      if (!inserted) inputBox.textContent = text;
      dispatchTextEvents(inputBox);
      return;
    }

    inputBox.innerText = text;
    dispatchTextEvents(inputBox);
  }

  function pressEnter(inputBox) {
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      inputBox.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
    });
  }

  function pasteToComposer(text, shouldSend = false) {
    if (inputHidden) setInputHidden(false);

    const inputBox = findInputBox();
    if (!inputBox) {
      alert('未找到输入框，请刷新页面后重试。');
      return false;
    }

    setComposerText(inputBox, text);

    if (shouldSend) {
      setTimeout(() => {
        const sendBtn = findSendButton();
        if (sendBtn) sendBtn.click();
        else pressEnter(inputBox);
      }, 150);
    }
    return true;
  }

  function getPrompts() {
    const raw = localStorage.getItem(STORAGE_KEYS.prompts);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          const prompts = parsed
            .filter(item => item && typeof item.text === 'string')
            .map(item => ({
              id: item.id || createId(),
              name: item.name || '未命名 Prompt',
              text: item.text
            }));

          let changed = false;
          prompts.forEach(item => {
            if (item.id === 'make-quiz' && item.text === LEGACY_MAKE_QUIZ_PROMPT) {
              item.text = DEFAULT_MAKE_QUIZ_PROMPT;
              changed = true;
            }
          });
          if (changed) savePrompts(prompts);
          return prompts;
        }
      } catch (err) {
        console.warn('[aichat] Prompt 列表读取失败，已使用默认列表。', err);
      }
    }

    const legacy = localStorage.getItem(STORAGE_KEYS.legacyPrompt);
    if (legacy) {
      const migrated = [{ ...DEFAULT_PROMPTS[0], text: legacy }, DEFAULT_PROMPTS[1]];
      savePrompts(migrated);
      return migrated;
    }

    savePrompts(DEFAULT_PROMPTS);
    return DEFAULT_PROMPTS.map(item => ({ ...item }));
  }

  function savePrompts(prompts) {
    localStorage.setItem(STORAGE_KEYS.prompts, JSON.stringify(prompts));
  }

  function makeFloatingButton(id, text, title, bottom, background) {
    if (document.getElementById(id)) return null;
    const btn = document.createElement('button');
    btn.id = id;
    btn.textContent = text;
    btn.title = title;
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: `${bottom}px`,
      right: '20px',
      zIndex: '9999',
      width: '48px',
      height: '48px',
      borderRadius: '50%',
      background,
      color: '#fff',
      fontSize: '20px',
      border: 'none',
      cursor: 'pointer',
      boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background 0.2s, transform 0.2s'
    });
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'translateY(-1px)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
    document.body.appendChild(btn);
    return btn;
  }

  function createSmallButton(text, background = '#334155') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    Object.assign(btn.style, {
      padding: '6px 10px',
      border: 'none',
      borderRadius: '6px',
      background,
      color: '#fff',
      cursor: 'pointer',
      fontSize: '13px',
      whiteSpace: 'nowrap'
    });
    return btn;
  }

  function createField(labelText, child) {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;font-size:13px;color:#334155;';
    const label = document.createElement('span');
    label.textContent = labelText;
    label.style.fontWeight = '600';
    wrap.appendChild(label);
    wrap.appendChild(child);
    return wrap;
  }

  function closePromptDialog() {
    document.getElementById('ds-prompt-dialog')?.remove();
  }

  function openPromptDialog() {
    const existing = document.getElementById('ds-prompt-dialog');
    if (existing) {
      existing.remove();
      return;
    }

    let prompts = getPrompts();
    let editingId = prompts[0]?.id || null;

    const dialog = document.createElement('div');
    dialog.id = 'ds-prompt-dialog';
    dialog.style.cssText = [
      'position:fixed',
      'top:50%',
      'left:50%',
      'transform:translate(-50%, -50%)',
      'width:min(760px, calc(100vw - 32px))',
      'max-height:min(760px, calc(100vh - 32px))',
      'background:#fff',
      'color:#0f172a',
      'border:1px solid #cbd5e1',
      'border-radius:10px',
      'box-shadow:0 20px 50px rgba(15,23,42,0.25)',
      'z-index:10000',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e2e8f0;';

    const title = document.createElement('div');
    title.textContent = 'Prompt 管理';
    title.style.cssText = 'font-size:16px;font-weight:700;';
    header.appendChild(title);

    const closeBtn = createSmallButton('关闭', '#64748b');
    closeBtn.addEventListener('click', closePromptDialog);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = document.createElement('div');
    body.style.cssText = 'display:grid;grid-template-columns:minmax(240px, 1fr) minmax(280px, 1.2fr);gap:14px;padding:14px;overflow:auto;';

    const listPane = document.createElement('div');
    listPane.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:0;';

    const editPane = document.createElement('div');
    editPane.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:0;';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '例如：提取关键点';
    nameInput.style.cssText = 'width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:7px;padding:8px;font-size:14px;';

    const textInput = document.createElement('textarea');
    textInput.placeholder = '输入 Prompt 内容';
    textInput.style.cssText = 'width:100%;height:260px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:7px;padding:8px;font-size:14px;line-height:1.5;resize:vertical;';

    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;';

    const newBtn = createSmallButton('新增', '#0f766e');
    const saveBtn = createSmallButton('保存', '#16a34a');
    const pasteBtn = createSmallButton('粘贴', '#2563eb');
    const sendBtn = createSmallButton('粘贴并发送', '#0f172a');
    const resetBtn = createSmallButton('恢复默认', '#b45309');

    actionRow.append(newBtn, saveBtn, pasteBtn, sendBtn, resetBtn);
    editPane.append(
      createField('名称', nameInput),
      createField('内容', textInput),
      actionRow
    );

    function selectedPrompt() {
      return prompts.find(item => item.id === editingId) || prompts[0] || null;
    }

    function fillEditor(prompt) {
      editingId = prompt?.id || null;
      nameInput.value = prompt?.name || '';
      textInput.value = prompt?.text || '';
      renderList();
    }

    function persistAndRender() {
      savePrompts(prompts);
      renderList();
    }

    function renderList() {
      listPane.innerHTML = '';

      prompts.forEach(prompt => {
        const row = document.createElement('div');
        row.style.cssText = [
          'border:1px solid #e2e8f0',
          'border-radius:8px',
          'padding:10px',
          'display:flex',
          'flex-direction:column',
          'gap:8px',
          'background:' + (prompt.id === editingId ? '#eff6ff' : '#fff')
        ].join(';');

        const rowTitle = document.createElement('button');
        rowTitle.type = 'button';
        rowTitle.textContent = prompt.name || '未命名 Prompt';
        rowTitle.style.cssText = 'border:none;background:transparent;padding:0;text-align:left;font-weight:700;color:#0f172a;cursor:pointer;';
        rowTitle.addEventListener('click', () => fillEditor(prompt));

        const preview = document.createElement('div');
        preview.textContent = prompt.text.replace(/\s+/g, ' ').slice(0, 90);
        preview.style.cssText = 'font-size:12px;line-height:1.4;color:#64748b;overflow:hidden;';

        const rowActions = document.createElement('div');
        rowActions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

        const rowPaste = createSmallButton('粘贴', '#2563eb');
        rowPaste.addEventListener('click', () => pasteToComposer(prompt.text, false));

        const rowSend = createSmallButton('粘贴并发送', '#0f172a');
        rowSend.addEventListener('click', () => pasteToComposer(prompt.text, true));

        const rowEdit = createSmallButton('编辑', '#475569');
        rowEdit.addEventListener('click', () => fillEditor(prompt));

        const rowDelete = createSmallButton('删除', '#dc2626');
        rowDelete.addEventListener('click', () => {
          if (prompts.length <= 1) {
            alert('至少保留一个 Prompt。');
            return;
          }
          if (!confirm(`删除 Prompt「${prompt.name}」？`)) return;
          prompts = prompts.filter(item => item.id !== prompt.id);
          if (editingId === prompt.id) editingId = prompts[0]?.id || null;
          persistAndRender();
          fillEditor(selectedPrompt());
        });

        rowActions.append(rowPaste, rowSend, rowEdit, rowDelete);
        row.append(rowTitle, preview, rowActions);
        listPane.appendChild(row);
      });
    }

    newBtn.addEventListener('click', () => {
      const prompt = { id: createId(), name: '新 Prompt', text: '' };
      prompts.unshift(prompt);
      persistAndRender();
      fillEditor(prompt);
      nameInput.select();
    });

    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim() || '未命名 Prompt';
      const text = textInput.value.trim();
      if (!text) {
        alert('Prompt 内容不能为空。');
        return;
      }

      const current = selectedPrompt();
      if (current) {
        current.name = name;
        current.text = text;
      } else {
        const prompt = { id: createId(), name, text };
        prompts.unshift(prompt);
        editingId = prompt.id;
      }
      persistAndRender();
    });

    pasteBtn.addEventListener('click', () => {
      const text = textInput.value.trim();
      if (!text) return alert('Prompt 内容不能为空。');
      pasteToComposer(text, false);
    });

    sendBtn.addEventListener('click', () => {
      const text = textInput.value.trim();
      if (!text) return alert('Prompt 内容不能为空。');
      pasteToComposer(text, true);
    });

    resetBtn.addEventListener('click', () => {
      if (!confirm('恢复默认会覆盖当前 Prompt 列表，确定继续？')) return;
      prompts = DEFAULT_PROMPTS.map(item => ({ ...item }));
      editingId = prompts[0].id;
      persistAndRender();
      fillEditor(prompts[0]);
    });

    body.append(listPane, editPane);
    dialog.appendChild(body);
    document.body.appendChild(dialog);
    fillEditor(selectedPrompt());
  }

  function setupPromptButton() {
    const btn = makeFloatingButton('ds-prompts-btn', '📋', 'Prompt 管理', 140, '#0f172a');
    if (!btn) return;
    btn.addEventListener('click', openPromptDialog);
  }

  function setupInputToggler() {
    if (document.getElementById('ds-toggle-input-btn')) return;

    const btn = makeFloatingButton('ds-toggle-input-btn', '💬', '隐藏/展开输入框', 20, '#4f46e5');
    if (!btn) return;

    btn.addEventListener('click', () => {
      if (!setInputHidden(!inputHidden)) {
        alert('未找到输入框，请稍后重试。');
      }
    });
  }

  function setupQuizToggle() {
    const btn = makeFloatingButton('ds-toggle-quiz-btn', '🧪', '开启测验模式', 80, '#475569');
    if (!btn) return;

    function updateBtnState() {
      btn.textContent = quizEnabled ? '✅' : '🧪';
      btn.title = quizEnabled ? '测验模式已开，点击恢复原文' : '开启测验模式';
      btn.style.background = quizEnabled ? '#16a34a' : '#475569';
    }

    btn.addEventListener('click', () => {
      quizEnabled = !quizEnabled;
      localStorage.setItem(STORAGE_KEYS.quizEnabled, quizEnabled ? '1' : '0');
      updateBtnState();

      if (quizEnabled) {
        clearManualRestoredMarks();
        scanAndConvert();
      } else {
        restoreConvertedBlocks();
      }
    });

    updateBtnState();
  }

  function parseFieldLine(line) {
    const cleaned = String(line || '').trim().replace(/^\*\*|\*\*$/g, '').trim();
    const match = cleaned.match(/^【\s*(答案解析|正确答案|参考答案|答案|解析|解释|题解|详解|关键词)\s*】\s*[：:]?\s*([\s\S]*)$/) ||
      cleaned.match(/^(答案解析|正确答案|参考答案|答案|解析|解释|题解|详解|关键词)\s*[：:]\s*([\s\S]*)$/);
    if (!match) return null;
    let section = '';
    if (/^(答案|正确答案|参考答案)$/.test(match[1])) section = 'answer';
    if (/^(答案解析|解析|解释|题解|详解)$/.test(match[1])) section = 'analysis';
    if (match[1] === '关键词') section = 'keywords';
    return section ? { section, value: match[2].trim() } : null;
  }

  function appendSection(target, key, value, joiner = '\n') {
    const text = String(value || '').trim();
    if (!text) return;
    target[key] += target[key] ? joiner + text : text;
  }

  function parseQuestionBlock(type, content) {
    const parsed = { stem: '', answer: '', analysis: '', keywords: '' };
    const options = [];
    let section = 'stem';

    String(content || '').split('\n').forEach(rawLine => {
      const line = rawLine.trim();
      if (!line) {
        if (section === 'analysis') appendSection(parsed, 'analysis', '');
        return;
      }

      const field = parseFieldLine(line);
      if (field) {
        section = field.section;
        appendSection(parsed, section, field.value, section === 'keywords' ? '|' : '\n');
        return;
      }

      const optionMatch = line.match(/^([A-D])[\.．、]\s*(.+)$/);
      if ((type === '单选题' || type === '多选题') && section === 'stem' && optionMatch) {
        options.push({ label: optionMatch[1], text: optionMatch[2].trim() });
        return;
      }

      if (section === 'keywords') appendSection(parsed, 'keywords', line, '|');
      else appendSection(parsed, section, line, section === 'answer' ? ' ' : '\n');
    });

    const answer = parsed.answer.trim();
    const analysis = parsed.analysis.trim();
    const questionText = parsed.stem.trim();

    if (!answer || !analysis) return null;
    if ((type === '单选题' || type === '多选题') && options.length < 2) return null;
    if (!questionText) return null;

    return {
      type,
      stem: questionText,
      options,
      answer,
      analysis,
      keywords: parsed.keywords.trim()
    };
  }

  function normalizeQuizText(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/```(?:text|markdown|md)?\s*/gi, '')
      .replace(/```/g, '')
      .replace(/\*\*【/g, '【')
      .replace(/】\*\*/g, '】')
      .replace(/\*\*(答案解析|正确答案|参考答案|答案|解析|解释|题解|详解|关键词)([：:])/g, '$1$2')
      .replace(/([：:])\*\*/g, '$1');
    }

  function parseQuestions(text) {
    const normalized = normalizeQuizText(text);
    const typePattern = SUPPORTED_TYPES.map(escapeRegExp).join('|');
    const headingRegex = new RegExp(`(^|\\n)\\s*(?:-{3,}\\s*\\n\\s*)?(?:\\d+[\\.、]\\s*)?【(${typePattern})】`, 'g');
    const headings = [];
    let match;

    while ((match = headingRegex.exec(normalized)) !== null) {
      const fullStart = match.index + match[1].length;
      headings.push({ index: fullStart, type: match[2], headerLength: match[0].length - match[1].length });
    }

    if (!headings.length) return [];

    const questions = [];
    headings.forEach((heading, idx) => {
      const start = heading.index + heading.headerLength;
      const end = headings[idx + 1]?.index ?? normalized.length;
      const content = normalized.slice(start, end).replace(/\n-{3,}\s*$/g, '').trim();
      const parsed = parseQuestionBlock(heading.type, content);
      if (parsed) questions.push(parsed);
    });

    return questions;
  }

  function shouldConvertText(text, questions) {
    if (!questions.length) return false;
    const normalized = normalizeQuizText(text);
    if (!/(^|\n)\s*(?:\d+[\.、]\s*)?【(?:单选题|多选题|填空题|简答题|判断题)】/.test(normalized)) return false;
    if (!/(^|\n)\s*(?:【\s*(?:答案|正确答案|参考答案)\s*】|(?:答案|正确答案|参考答案)\s*[：:])/.test(normalized)) return false;
    if (!/(^|\n)\s*(?:【\s*(?:答案解析|解析|解释|题解|详解)\s*】|(?:答案解析|解析|解释|题解|详解)\s*[：:])/.test(normalized)) return false;

    const headings = normalized.match(/(^|\n)\s*(?:\d+[\.、]\s*)?【(?:单选题|多选题|填空题|简答题|判断题)】/g) || [];
    return questions.length === headings.length;
  }

  function renderFeedbackAnswer(prefix, answer, analysis) {
    return `${prefix}${answer ? `<b>${escapeHtml(answer)}</b>` : ''}` +
      (analysis ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;white-space:normal;line-height:1.65;">${multilineHtml(analysis)}</div>` : '');
  }

  function createCard(q, index) {
    const card = document.createElement('div');
    card.className = 'quiz-card';
    card.style.cssText = 'background:#fff;color:#0f172a;border:1px solid #d6dbe4;border-radius:8px;padding:14px;margin:12px 0;box-shadow:0 1px 4px rgba(15,23,42,0.08);';
    const recordKey = getQuizRecordKey(q);
    const record = getQuizRecord(q);

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;line-height:1.5;white-space:pre-wrap;';
    title.textContent = `${index + 1}. [${q.type}] ${q.stem}`;
    card.appendChild(title);

    const userInputArea = document.createElement('div');
    userInputArea.style.marginTop = '12px';

    if (q.type === '单选题' || q.type === '多选题') {
      const isMulti = q.type === '多选题';
      q.options.forEach(opt => {
        const lbl = document.createElement('label');
        lbl.style.cssText = 'display:block;margin:6px 0;cursor:pointer;line-height:1.5;';
        const inp = document.createElement('input');
        inp.type = isMulti ? 'checkbox' : 'radio';
        inp.name = `ds-q-${recordKey}-${index}`;
        inp.value = opt.label;
        lbl.appendChild(inp);
        lbl.appendChild(document.createTextNode(` ${opt.label}. ${opt.text}`));
        userInputArea.appendChild(lbl);
      });

      card._getAnswer = () => {
        const checked = [...userInputArea.querySelectorAll('input:checked')].map(c => c.value).sort();
        return checked.join(',');
      };
    } else if (q.type === '填空题' || q.type === '判断题') {
      const input = document.createElement('input');
      input.type = 'text';
      input.style.cssText = 'width:min(520px, 100%);box-sizing:border-box;padding:7px;border:1px solid #cbd5e1;border-radius:6px;';
      userInputArea.appendChild(input);
      card._getAnswer = () => input.value.trim();
    } else {
      const textarea = document.createElement('textarea');
      textarea.style.cssText = 'width:100%;height:88px;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px;resize:vertical;';
      userInputArea.appendChild(textarea);
      card._getAnswer = () => textarea.value.trim();
    }

    card.appendChild(userInputArea);
    card._correctAns = q.answer;
    card._analysis = q.analysis;

    const feedback = document.createElement('div');
    feedback.style.cssText = 'margin-top:10px;font-size:14px;line-height:1.5;';
    card.appendChild(feedback);

    function fillSavedAnswer(answer) {
      const saved = String(answer || '');
      if (!saved) return;
      if (q.type === '单选题' || q.type === '多选题') {
        const values = saved.split(',').map(v => v.trim()).filter(Boolean);
        userInputArea.querySelectorAll('input').forEach(input => {
          input.checked = values.includes(input.value);
        });
      } else {
        const input = userInputArea.querySelector('input, textarea');
        if (input) input.value = saved;
      }
    }

    function renderSavedFeedback(saved) {
      if (!saved || !saved.status || saved.status === 'draft') return;
      if (q.type === '简答题') {
        feedback.innerHTML = renderFeedbackAnswer('上次参考答案：', q.answer, q.analysis);
        return;
      }
      if (saved.status === 'checked') {
        feedback.innerHTML = saved.isCorrect
          ? `<span style="color:#15803d;">上次正确</span>${q.analysis ? renderFeedbackAnswer('', '', q.analysis) : ''}`
          : `<span style="color:#dc2626;">上次错误，正确答案：${escapeHtml(q.answer)}</span>${q.analysis ? renderFeedbackAnswer('', '', q.analysis) : ''}`;
      }
    }

    fillSavedAnswer(record?.userAnswer);
    renderSavedFeedback(record);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;';

    const checkBtn = createSmallButton('自行检查', '#4f46e5');
    checkBtn.addEventListener('click', () => {
      const userAns = card._getAnswer();
      const correct = q.answer;

      if (q.type === '简答题') {
        setQuizRecord(q, { userAnswer: userAns, status: 'review' });
        feedback.innerHTML = renderFeedbackAnswer('参考答案：', correct, q.analysis);
        return;
      }

      let isCorrect = false;
      if (q.type === '单选题' || q.type === '多选题') {
        isCorrect = normalizeChoiceAnswer(userAns) === normalizeChoiceAnswer(correct);
      } else {
        isCorrect = normalizeTextAnswer(userAns) === normalizeTextAnswer(correct);
      }

      feedback.innerHTML = isCorrect
        ? `<span style="color:#15803d;">正确</span>${q.analysis ? renderFeedbackAnswer('', '', q.analysis) : ''}`
        : `<span style="color:#dc2626;">错误，正确答案：${escapeHtml(correct)}</span>${q.analysis ? renderFeedbackAnswer('', '', q.analysis) : ''}`;
      setQuizRecord(q, { userAnswer: userAns, status: 'checked', isCorrect });
    });

    userInputArea.querySelectorAll('input, textarea').forEach(input => {
      input.addEventListener('input', () => {
        feedback.innerHTML = '';
        setQuizRecord(q, { userAnswer: card._getAnswer(), status: 'draft' });
      });
      input.addEventListener('change', () => {
        feedback.innerHTML = '';
        setQuizRecord(q, { userAnswer: card._getAnswer(), status: 'draft' });
      });
    });

    btnRow.appendChild(checkBtn);
    card.appendChild(btnRow);

    addToQuestionBank(q);

    return card;
  }

  function buildDeepReviewPrompt(cards) {
    let prompt = '请作为一位严谨的学科老师，逐一批改以下题目，并给出针对性讲解。\n';
    prompt += '注意：\n';
    prompt += '- 判断我的答案是否正确，若错误请给出正确答案；\n';
    prompt += '- 解释必须聚焦于该题的核心知识点，避免冗长；\n';
    prompt += '- 如果题目信息不足或存在歧义，请明确指出并询问我补充信息，不要自行猜测答案；\n';
    prompt += '- 请按照“题号 - 判断 - 讲解”的格式输出。\n\n';

    cards.forEach((card, i) => {
      const userAns = card._getAnswer() || '未作答';
      const correct = card._correctAns || '未提供';
      const stem = card.querySelector('div')?.textContent || '';
      prompt += `${i + 1}. ${stem}\n我的答案：${userAns}\n参考答案：${correct}\n\n`;
    });

    prompt += '现在请开始批改。';
    return prompt;
  }

  function getCandidateBlocks() {
    const candidates = [
      ...document.querySelectorAll([
        '.ds-markdown',
        '[class*="markdown"]',
        '.message-content',
        '[class*="message-content"]',
        '[data-message-author-role="assistant"]',
        '[class*="assistant"]'
      ].join(','))
    ].filter(block => {
      if (!isVisible(block)) return false;
      if (block.closest('#ds-prompt-dialog')) return false;
      if (block.closest('.quiz-card')) return false;
      if (block.closest('[data-ds-quiz-manual-restored="1"]')) return false;
      return true;
    });

    return candidates.filter(block => !candidates.some(other => other !== block && block.contains(other)));
  }

  function convertBlock(block, questions) {
    if (renderedBlocks.has(block)) return;

    renderedBlocks.set(block, { html: block.innerHTML });
    block.dataset.dsQuizRendered = '1';
    delete block.dataset.dsQuizManualRestored;
    block.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'ds-quiz-container';
    container.style.cssText = 'display:block;width:100%;';

    const cards = [];
    questions.forEach((q, idx) => {
      const card = createCard(q, idx);
      cards.push(card);
      container.appendChild(card);
    });

    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;';

    const pasteReviewBtn = createSmallButton('粘贴批改请求', '#2563eb');
    pasteReviewBtn.addEventListener('click', () => pasteToComposer(buildDeepReviewPrompt(cards), false));

    const sendReviewBtn = createSmallButton('粘贴并发送批改请求', '#0f172a');
    sendReviewBtn.addEventListener('click', () => pasteToComposer(buildDeepReviewPrompt(cards), true));

    const restoreBtn = createSmallButton('恢复原文', '#64748b');
    restoreBtn.addEventListener('click', () => restoreBlock(block, true));

    actionRow.append(pasteReviewBtn, sendReviewBtn, restoreBtn);
    container.appendChild(actionRow);
    block.appendChild(container);
  }

  function restoreBlock(block, manual = false) {
    const original = renderedBlocks.get(block);
    if (!original) return;
    block.innerHTML = original.html;
    delete block.dataset.dsQuizRendered;
    if (manual) block.dataset.dsQuizManualRestored = '1';
    else delete block.dataset.dsQuizManualRestored;
    renderedBlocks.delete(block);
  }

  function restoreConvertedBlocks() {
    getCandidateBlocks().forEach(block => {
      if (renderedBlocks.has(block)) restoreBlock(block);
    });
  }

  function clearManualRestoredMarks() {
    document.querySelectorAll('[data-ds-quiz-manual-restored="1"]').forEach(block => {
      delete block.dataset.dsQuizManualRestored;
    });
  }

  function scanAndConvert() {
    if (!quizEnabled) return;

    getCandidateBlocks().forEach(block => {
      if (renderedBlocks.has(block) || block.dataset.dsQuizRendered) return;
      if (block.dataset.dsQuizManualRestored === '1') return;
      const text = block.innerText || '';
      if (!text.includes('【') || !text.includes('答案：') || !text.includes('解析：')) return;

      const questions = parseQuestions(text);
      if (!shouldConvertText(text, questions)) return;

      convertBlock(block, questions);
    });
  }

  function scheduleScan() {
    if (!quizEnabled) return;
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanAndConvert, 300);
  }

  function closeSyncConfigDialog() {
    document.getElementById('ds-sync-config-dialog')?.remove();
  }

  function openSyncConfigDialog() {
    const existing = document.getElementById('ds-sync-config-dialog');
    if (existing) { existing.remove(); return; }

    const cfg = getGiteeConfig();

    const dialog = document.createElement('div');
    dialog.id = 'ds-sync-config-dialog';
    dialog.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
      'width:min(420px,calc(100vw-32px))', 'background:#fff', 'color:#0f172a',
      'border:1px solid #cbd5e1', 'border-radius:10px',
      'box-shadow:0 20px 50px rgba(15,23,42,0.25)', 'z-index:10001',
      'display:flex', 'flex-direction:column', 'overflow:hidden',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e2e8f0;';
    const title = document.createElement('div');
    title.textContent = '☁ Gitee 同步配置';
    title.style.cssText = 'font-size:16px;font-weight:700;';
    header.appendChild(title);
    const closeBtn = createSmallButton('关闭', '#64748b');
    closeBtn.addEventListener('click', closeSyncConfigDialog);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:14px;';

    const doSave = () => {
      saveGiteeConfig({
        token: tokenInput.value.trim(),
        repo: repoInput.value.trim(),
        path: pathInput.value.trim() || 'desktop-questions.json',
        autoSync: autoCheck.checked
      });
      closeSyncConfigDialog();
    };

    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.placeholder = 'Gitee 私人令牌';
    tokenInput.value = cfg.token;
    tokenInput.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:7px;font-size:14px;';
    tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });

    const repoInput = document.createElement('input');
    repoInput.type = 'text';
    repoInput.placeholder = '仓库，如：username/repo';
    repoInput.value = cfg.repo;
    repoInput.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:7px;font-size:14px;';
    repoInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.placeholder = '文件路径';
    pathInput.value = cfg.path;
    pathInput.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:7px;font-size:14px;';
    pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });

    const autoRow = document.createElement('label');
    autoRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;';
    const autoCheck = document.createElement('input');
    autoCheck.type = 'checkbox';
    autoCheck.checked = cfg.autoSync;
    autoRow.appendChild(autoCheck);
    autoRow.appendChild(document.createTextNode('自动同步（每次新题目自动推送到 Gitee）'));

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    const saveBtn = createSmallButton('💾 保存配置', '#16a34a');
    saveBtn.addEventListener('click', doSave);

    const testBtn = createSmallButton('🔄 立即推送', '#2563eb');
    testBtn.addEventListener('click', async () => {
      saveGiteeConfig({
        token: tokenInput.value.trim(),
        repo: repoInput.value.trim(),
        path: pathInput.value.trim() || 'desktop-questions.json',
        autoSync: autoCheck.checked
      });
      testBtn.textContent = '推送中...';
      testBtn.disabled = true;
      const ok = await syncToGitee(false);
      testBtn.textContent = ok ? '✓ 推送成功' : '✗ 推送失败';
      testBtn.style.background = ok ? '#16a34a' : '#dc2626';
      setTimeout(() => { testBtn.textContent = '🔄 立即推送'; testBtn.style.background = '#2563eb'; testBtn.disabled = false; }, 2000);
    });

    btnRow.append(saveBtn, testBtn);
    body.append(
      createField('Gitee Token', tokenInput),
      createField('仓库 (owner/repo)', repoInput),
      createField('文件路径', pathInput),
      autoRow,
      btnRow
    );
    body.appendChild(document.createElement('div')).innerHTML = '<span style="font-size:11px;color:#64748b">Token 在 gitee.com → 设置 → 私人令牌，需要仓库读写权限。推送的文件会自动同步到手机端网页。</span>';

    dialog.appendChild(body);
    document.body.appendChild(dialog);
  }

  function setupSyncConfigButton() {
    const btn = makeFloatingButton('ds-sync-config-btn', '⚙', 'Gitee 同步设置', 260, '#0f766e');
    if (!btn) return;
    btn.addEventListener('click', openSyncConfigDialog);
  }

  function closeExportDialog() {
    document.getElementById('ds-export-dialog')?.remove();
  }

  function openExportDialog() {
    const existing = document.getElementById('ds-export-dialog');
    if (existing) { existing.remove(); return; }

    const bank = loadQuestionBank();

    const dialog = document.createElement('div');
    dialog.id = 'ds-export-dialog';
    dialog.style.cssText = [
      'position:fixed',
      'top:50%',
      'left:50%',
      'transform:translate(-50%, -50%)',
      'width:min(800px, calc(100vw - 32px))',
      'max-height:min(700px, calc(100vh - 32px))',
      'background:#fff',
      'color:#0f172a',
      'border:1px solid #cbd5e1',
      'border-radius:10px',
      'box-shadow:0 20px 50px rgba(15,23,42,0.25)',
      'z-index:10000',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e2e8f0;';

    const title = document.createElement('div');
    title.textContent = '题库导出（' + bank.length + ' 道题）';
    title.style.cssText = 'font-size:16px;font-weight:700;';
    header.appendChild(title);

    const closeBtn = createSmallButton('关闭', '#64748b');
    closeBtn.addEventListener('click', closeExportDialog);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:14px;overflow:auto;flex:1;';

    if (!bank.length) {
      const empty = document.createElement('div');
      empty.textContent = '题库为空。开启测验模式后，解析到的题目会自动存入题库。';
      empty.style.cssText = 'color:#64748b;padding:24px;text-align:center;';
      body.appendChild(empty);
    } else {
      const textarea = document.createElement('textarea');
      textarea.readOnly = true;
      textarea.style.cssText = 'width:100%;height:360px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:7px;padding:10px;font-size:13px;line-height:1.6;resize:vertical;font-family:monospace;';
      textarea.value = bank.map((q, i) => (i ? '\n---\n\n' : '') + formatQuestionForExport(q)).join('');
      body.appendChild(textarea);

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

      const copyBtn = createSmallButton('复制全部（标准格式）', '#2563eb');
      copyBtn.addEventListener('click', () => {
        const text = bank.map((q, i) => (i ? '\n---\n\n' : '') + formatQuestionForExport(q)).join('');
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = '已复制';
          copyBtn.style.background = '#16a34a';
          setTimeout(() => { copyBtn.textContent = '复制全部（标准格式）'; copyBtn.style.background = '#2563eb'; }, 1500);
        }).catch(() => {
          textarea.select();
          document.execCommand('copy');
          copyBtn.textContent = '已复制';
          copyBtn.style.background = '#16a34a';
          setTimeout(() => { copyBtn.textContent = '复制全部（标准格式）'; copyBtn.style.background = '#2563eb'; }, 1500);
        });
      });

      const downloadBtn = createSmallButton('下载 JSON', '#0f766e');
      downloadBtn.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(bank, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'question_bank_' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(url);
      });

      const clearBtn = createSmallButton('清空题库', '#dc2626');
      clearBtn.addEventListener('click', () => {
        if (!confirm('确定清空全部 ' + bank.length + ' 道题？此操作不可恢复。')) return;
        saveQuestionBank([]);
        closeExportDialog();
      });

      const syncBtn = createSmallButton('☁ 推送到 Gitee', '#0f766e');
      syncBtn.id = 'ds-sync-status';
      syncBtn.addEventListener('click', async () => {
        syncBtn.textContent = '推送中...';
        syncBtn.disabled = true;
        const ok = await syncToGitee(false);
        syncBtn.disabled = false;
      });

      btnRow.append(copyBtn, downloadBtn, syncBtn, clearBtn);
      body.appendChild(btnRow);
    }

    dialog.appendChild(body);
    document.body.appendChild(dialog);
  }

  function setupExportButton() {
    const btn = makeFloatingButton('ds-export-btn', '📤', '导出题库', 200, '#0f766e');
    if (!btn) return;
    btn.addEventListener('click', openExportDialog);
  }

  function init() {
    setupInputToggler();
    setupQuizToggle();
    setupPromptButton();
    setupExportButton();
    setupSyncConfigButton();
    if (quizEnabled) scanAndConvert();

    if (!observer) {
      observer = new MutationObserver(() => {
        setupInputToggler();
        setupQuizToggle();
        setupPromptButton();
        setupExportButton();
        setupSyncConfigButton();
        scheduleScan();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
