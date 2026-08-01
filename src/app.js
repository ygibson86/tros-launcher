const invoke = window.__TAURI__.core.invoke;

function isImagePath(val) {
  return val && (val.includes(".") || val.includes("\\") || val.includes("/"));
}

const _iconCache = {};
async function loadIcon(relPath) {
  if (_iconCache[relPath]) return _iconCache[relPath];
  try {
    const dataUri = await invoke("read_icon_file", { path: relPath });
    _iconCache[relPath] = dataUri;
    return dataUri;
  } catch {
    return null;
  }
}

function iconHtml(val, fallback) {
  if (!val) return escapeHtml(fallback);
  return escapeHtml(val);
}

let state = {
  config: {
    password_hash: "",
    app_name: "LAUNCHER",
    app_logo: "L",
    minimize_on_launch: true,
    groups: [],
  },
  activeGroupId: null,
  editing: false,
  searchQuery: "",
};

// ---------- Утилиты ----------

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function openModal(id) {
  document.getElementById(id).classList.add("open");
}
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

document.querySelectorAll("[data-close]").forEach((el) => {
  el.addEventListener("click", () => closeModal(el.dataset.close));
});

document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// ---------- Кастомный confirm ----------
let confirmResolve = null;

function showConfirm(title, message) {
  return new Promise((resolve) => {
    document.getElementById("confirmTitle").textContent = title;
    document.getElementById("confirmMessage").textContent = message;
    confirmResolve = resolve;
    openModal("confirmModal");
  });
}

document.getElementById("confirmOk").addEventListener("click", () => {
  closeModal("confirmModal");
  if (confirmResolve) confirmResolve(true);
  confirmResolve = null;
});

document.getElementById("confirmCancel").addEventListener("click", () => {
  closeModal("confirmModal");
  if (confirmResolve) confirmResolve(false);
  confirmResolve = null;
});

async function persist() {
  await invoke("save_config", { config: state.config });
}

// ---------- Выбор файла иконки ----------
document.getElementById("btnIconBrowse").addEventListener("click", async () => {
  try {
    const path = await invoke("pick_and_copy_icon");
    if (!path) return;
    document.getElementById("btnIconInput").value = path;
  } catch (err) {
    showToast("Ошибка: " + err);
  }
});

document.getElementById("appLogoBrowse").addEventListener("click", async () => {
  try {
    const path = await invoke("pick_and_copy_icon");
    if (!path) return;
    document.getElementById("appLogoInput").value = path;
  } catch (err) {
    showToast("Ошибка: " + err);
  }
});

// ---------- Загрузка конфигурации ----------
async function loadConfig() {
  state.config = await invoke("get_config");
  if (!state.activeGroupId && state.config.groups.length > 0) {
    state.activeGroupId = state.config.groups[0].id;
  }
  applyBranding();
  applyTheme();
  render();
}

async function applyBranding() {
  const name = state.config.app_name || "LAUNCHER";
  const logo = state.config.app_logo || "L";
  document.getElementById("brandText").textContent = name;
  const brandMark = document.getElementById("brandMark");
  if (isImagePath(logo)) {
    const dataUri = await loadIcon(logo);
    brandMark.innerHTML = dataUri ? `<img src="${dataUri}" alt="" />` : "L";
  } else {
    brandMark.innerHTML = iconHtml(logo, "L");
  }
  document.title = name;
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    await getCurrentWindow().setTitle(name);
  } catch (e) {}
}

// ---------- Рендер ----------
function render() {
  renderGroupList();
  renderMain();
  document.body.classList.toggle("editing", state.editing);
}

function renderGroupList() {
  const list = document.getElementById("groupList");
  list.innerHTML = "";
  const groups = state.config.groups;
  groups.forEach((g, idx) => {
    const item = document.createElement("div");
    item.className = "group-item" + (g.id === state.activeGroupId ? " active" : "");
    item.innerHTML = `
      <span class="dot"></span>
      <span class="group-name">${escapeHtml(g.name)}</span>
      <span class="group-toolbar">
        <button class="mini-btn" data-action="up" title="Переместить вверх" ${idx === 0 ? "disabled" : ""}>▲</button>
        <button class="mini-btn" data-action="down" title="Переместить вниз" ${idx === groups.length - 1 ? "disabled" : ""}>▼</button>
        <button class="mini-btn" data-action="rename" title="Переименовать">✎</button>
      </span>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".group-toolbar")) return;
      state.activeGroupId = g.id;
      render();
    });
    item.querySelector('[data-action="up"]').addEventListener("click", (e) => {
      e.stopPropagation();
      moveGroup(g, -1);
    });
    item.querySelector('[data-action="down"]').addEventListener("click", (e) => {
      e.stopPropagation();
      moveGroup(g, 1);
    });
    item.querySelector('[data-action="rename"]').addEventListener("click", (e) => {
      e.stopPropagation();
      openGroupEditor(g);
    });

    item.dataset.groupId = g.id;
    item.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !state.editing || e.target.closest("button")) return;
      startDrag("group", g.id, null, e.clientX, e.clientY, item, groupGhostHtml(g));
    });

    list.appendChild(item);
  });
}

function moveGroup(group, direction) {
  const arr = state.config.groups;
  const idx = arr.findIndex((g) => g.id === group.id);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= arr.length) return;
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  persist();
  render();
}

function activeGroup() {
  return state.config.groups.find((g) => g.id === state.activeGroupId) || null;
}

function renderMain() {
  const query = state.searchQuery.trim().toLowerCase();
  if (query) {
    renderSearchResults(query);
    return;
  }

  const group = activeGroup();
  document.getElementById("groupTitle").textContent = group ? group.name : "Нет групп";
  const grid = document.getElementById("buttonGrid");
  const empty = document.getElementById("emptyState");
  grid.innerHTML = "";

  if (!group) {
    empty.style.display = "block";
    empty.textContent = "Создайте первую группу.";
    return;
  }

  if (group.buttons.length === 0) {
    empty.style.display = "block";
    empty.textContent = "В этой группе пока нет кнопок.";
  } else {
    empty.style.display = "none";
  }

  group.buttons.forEach((btn, idx) => {
    const tile = createTile(btn, group, {
      showMove: true,
      moveIdx: idx,
      moveTotal: group.buttons.length,
      showGroupTag: false,
    });
    grid.appendChild(tile);
  });
}

function renderSearchResults(query) {
  document.getElementById("groupTitle").textContent = `Поиск: "${state.searchQuery.trim()}"`;
  const grid = document.getElementById("buttonGrid");
  const empty = document.getElementById("emptyState");
  grid.innerHTML = "";

  const matches = [];
  state.config.groups.forEach((g) => {
    g.buttons.forEach((b) => {
      const hay = (b.name + " " + (b.command || "") + " " + (b.comment || "")).toLowerCase();
      if (hay.includes(query)) matches.push({ group: g, button: b });
    });
  });

  if (matches.length === 0) {
    empty.style.display = "block";
    empty.textContent = "Ничего не найдено.";
    return;
  }
  empty.style.display = "none";

  matches.forEach(({ group, button }) => {
    const tile = createTile(button, group, {
      showMove: false,
      showGroupTag: true,
    });
    grid.appendChild(tile);
  });
}

function createTile(btn, group, opts) {
  const desc = btn.comment || "";
  const badges = [];
  if (btn.console) badges.push('<span class="tile-badge">CONSOLE</span>');
  if (btn.admin) badges.push('<span class="tile-badge admin">ADMIN</span>');

  const isImgIcon = btn.icon && isImagePath(btn.icon);
  const tile = document.createElement("div");
  tile.className = "tile" + (btn.console ? " console" : "");

  const iconContent = isImgIcon
    ? '<div class="tile-icon"><img class="tile-icon-img" alt="" /></div>'
    : `<div class="tile-icon">${iconHtml(btn.icon, "▶")}</div>`;

  tile.innerHTML = `
    ${badges.length ? `<div class="tile-badges">${badges.join("")}</div>` : ""}
    ${iconContent}
    <div class="tile-name">${escapeHtml(btn.name)}</div>
    ${desc ? `<div class="tile-cmd">${escapeHtml(desc)}</div>` : ""}
    <div class="tile-footer">
      <div class="tile-footer-left">
        ${
          opts.showMove
            ? `<div class="tile-move">
                 <button data-action="up" title="Переместить раньше" ${opts.moveIdx === 0 ? "disabled" : ""}>◀</button>
                 <button data-action="down" title="Переместить позже" ${opts.moveIdx === opts.moveTotal - 1 ? "disabled" : ""}>▶</button>
               </div>`
            : ""
        }
        ${opts.showGroupTag ? `<div class="tile-group-tag">${escapeHtml(group.name)}</div>` : ""}
      </div>
      <div class="tile-actions">
        <button class="tile-duplicate" title="Дублировать">⧉</button>
        <button class="tile-delete" title="Удалить">✕</button>
      </div>
    </div>
  `;

  tile.addEventListener("click", (e) => {
    if (e.target.closest(".tile-actions") || e.target.closest(".tile-move")) return;
    if (state.editing) {
      openButtonEditor(group, btn);
    } else {
      launchButton(btn);
    }
  });

  tile.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !state.editing || e.target.closest("button")) return;
    startDrag("button", btn.id, group.id, e.clientX, e.clientY, tile, tileGhostHtml(btn));
  });

  tile.querySelector(".tile-delete").addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const confirmed = await showConfirm("Удаление кнопки", `Удалить кнопку «${btn.name}»?`);
      if (!confirmed) return;
      group.buttons = group.buttons.filter((b) => b.id !== btn.id);
      await persist();
      render();
      showToast("Кнопка удалена");
    } catch (err) {
      showToast("Ошибка: " + err.message);
    }
  });

  tile.querySelector(".tile-duplicate").addEventListener("click", async (e) => {
    e.stopPropagation();
    const copy = { ...btn, id: uid("btn"), name: btn.name + " (копия)" };
    const idx = group.buttons.findIndex((b) => b.id === btn.id);
    group.buttons.splice(idx + 1, 0, copy);
    await persist();
    render();
    showToast("Кнопка продублирована");
  });

  if (opts.showMove) {
    const upBtn = tile.querySelector('[data-action="up"]');
    const downBtn = tile.querySelector('[data-action="down"]');
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      moveButton(group, btn, -1);
    });
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      moveButton(group, btn, 1);
    });
  }

  if (isImgIcon) {
    loadIcon(btn.icon).then((dataUri) => {
      const img = tile.querySelector(".tile-icon-img");
      if (img && dataUri) img.src = dataUri;
    });
  }

  return tile;
}

function moveButton(group, button, direction) {
  const arr = group.buttons;
  const idx = arr.findIndex((b) => b.id === button.id);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= arr.length) return;
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  persist();
  render();
}

document.getElementById("searchInput").addEventListener("input", (e) => {
  state.searchQuery = e.target.value;
  render();
});

const _escDiv = document.createElement("div");
function escapeHtml(str) {
  _escDiv.textContent = str ?? "";
  return _escDiv.innerHTML;
}

// ---------- Запуск ----------
async function launchButton(btn) {
  try {
    await invoke("launch_program", {
      command: btn.command,
      console: !!btn.console,
      powershell: !!btn.powershell,
      admin: !!btn.admin,
    });
  } catch (err) {
    showToast("Ошибка запуска: " + err);
  }
}

// ---------- Режим редактирования ----------
const lockBtn = document.getElementById("lockBtn");
const lockLabel = document.getElementById("lockLabel");

lockBtn.addEventListener("click", async () => {
  if (state.editing) {
    state.editing = false;
    updateLockUI();
    render();
    return;
  }
  const hasPw = await invoke("has_password");
  if (!hasPw) {
    state.editing = true;
    updateLockUI();
    render();
    showToast("Пароль не задан. Рекомендуем установить его в настройках.");
    return;
  }
  document.getElementById("passwordModalTitle").textContent = "Введите пароль редактирования";
  document.getElementById("passwordInput").value = "";
  document.getElementById("passwordError").textContent = "";
  openModal("passwordModal");
  document.getElementById("passwordInput").focus();
});

function updateLockUI() {
  lockBtn.classList.toggle("unlocked", state.editing);
  lockLabel.textContent = state.editing ? "Редактирование" : "Заблокировано";
}

// ---------- Тема ----------
function applyTheme() {
  const theme = state.config.theme || "dark";
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "");
}

document.getElementById("themeBtn").addEventListener("click", async () => {
  state.config.theme = state.config.theme === "light" ? "dark" : "light";
  applyTheme();
  await persist();
});

document.getElementById("passwordSubmit").addEventListener("click", async () => {
  const pw = document.getElementById("passwordInput").value;
  const ok = await invoke("verify_password", { password: pw });
  if (ok) {
    closeModal("passwordModal");
    state.editing = true;
    updateLockUI();
    render();
  } else {
    document.getElementById("passwordError").textContent = "Неверный пароль";
  }
});

document.getElementById("passwordInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("passwordSubmit").click();
});

// ---------- Группы ----------
let editingGroupRef = null;

function openGroupEditor(group) {
  editingGroupRef = group;
  document.getElementById("groupModalTitle").textContent = group ? "Переименовать группу" : "Новая группа";
  document.getElementById("groupNameInput").value = group ? group.name : "";
  openModal("groupModal");
  document.getElementById("groupNameInput").focus();
}

document.getElementById("addGroupBtn").addEventListener("click", () => {
  openGroupEditor(null);
});

document.getElementById("groupSubmit").addEventListener("click", async () => {
  const name = document.getElementById("groupNameInput").value.trim();
  if (!name) return;
  if (editingGroupRef) {
    editingGroupRef.name = name;
  } else {
    const g = { id: uid("group"), name, buttons: [] };
    state.config.groups.push(g);
    state.activeGroupId = g.id;
  }
  await persist();
  closeModal("groupModal");
  render();
});

document.getElementById("deleteGroupBtn").addEventListener("click", async () => {
  const group = activeGroup();
  if (!group) return;
  const confirmed = await showConfirm("Удаление группы", `Удалить группу «${group.name}» со всеми кнопками?`);
  if (!confirmed) return;
  state.config.groups = state.config.groups.filter((g) => g.id !== group.id);
  state.activeGroupId = state.config.groups[0]?.id || null;
  await persist();
  render();
  showToast("Группа удалена");
});

// ---------- Кнопки ----------
let editingButtonRef = null;

function populateGroupSelect(selectedGroupId) {
  const select = document.getElementById("btnGroupSelect");
  select.innerHTML = "";
  state.config.groups.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    if (g.id === selectedGroupId) opt.selected = true;
    select.appendChild(opt);
  });
}

function openButtonEditor(group, button) {
  editingButtonRef = { group, button };
  document.getElementById("buttonModalTitle").textContent = button ? "Редактировать кнопку" : "Новая кнопка";
  document.getElementById("btnNameInput").value = button?.name || "";
  populateGroupSelect(group.id);
  document.getElementById("btnCommentInput").value = button?.comment || "";
  document.getElementById("btnIconInput").value = button?.icon || "";
  document.getElementById("btnCommandInput").value = button?.command || "";
  document.getElementById("btnConsoleInput").checked = !!button?.console;
  document.getElementById("btnPowershellInput").checked = !!button?.powershell;
  document.getElementById("btnAdminInput").checked = !!button?.admin;
  openModal("buttonModal");
  document.getElementById("btnNameInput").focus();
}

document.getElementById("addButtonBtn").addEventListener("click", () => {
  const group = activeGroup();
  if (!group) {
    showToast("Сначала создайте группу");
    return;
  }
  openButtonEditor(group, null);
});

document.getElementById("btnBrowseFile").addEventListener("click", async () => {
  try {
    const path = await invoke("pick_file");
    if (!path) return;
    const textarea = document.getElementById("btnCommandInput");
    const isPowershell = document.getElementById("btnPowershellInput").checked;
    const line = isPowershell
      ? `Start-Process "${path}"`
      : `start "" "${path}"`;
    textarea.value = textarea.value ? `${textarea.value}\n${line}` : line;
    textarea.focus();
  } catch (err) {
    showToast("Не удалось открыть диалог выбора файла: " + err);
  }
});

document.getElementById("buttonSubmit").addEventListener("click", async () => {
  const name = document.getElementById("btnNameInput").value.trim();
  const command = document.getElementById("btnCommandInput").value.trim();
  if (!name || !command) {
    showToast("Укажите название и команду");
    return;
  }
  const comment = document.getElementById("btnCommentInput").value.trim();
  const icon = document.getElementById("btnIconInput").value.trim();
  const isConsole = document.getElementById("btnConsoleInput").checked;
  const isPowershell = document.getElementById("btnPowershellInput").checked;
  const isAdmin = document.getElementById("btnAdminInput").checked;
  const targetGroupId = document.getElementById("btnGroupSelect").value;
  const targetGroup = state.config.groups.find((g) => g.id === targetGroupId) || editingButtonRef.group;

  if (editingButtonRef.button) {
    Object.assign(editingButtonRef.button, {
      name,
      command,
      comment,
      console: isConsole,
      powershell: isPowershell,
      admin: isAdmin,
      icon,
    });
    if (targetGroup.id !== editingButtonRef.group.id) {
      editingButtonRef.group.buttons = editingButtonRef.group.buttons.filter(
        (b) => b.id !== editingButtonRef.button.id
      );
      targetGroup.buttons.push(editingButtonRef.button);
      state.activeGroupId = targetGroup.id;
    }
  } else {
    targetGroup.buttons.push({
      id: uid("btn"),
      name,
      command,
      comment,
      console: isConsole,
      powershell: isPowershell,
      admin: isAdmin,
      icon,
    });
    state.activeGroupId = targetGroup.id;
  }
  await persist();
  closeModal("buttonModal");
  render();
});

// ---------- Смена пароля ----------
document.getElementById("passwordSettingsBtn").addEventListener("click", () => {
  document.getElementById("oldPasswordInput").value = "";
  document.getElementById("newPasswordInput").value = "";
  document.getElementById("changePasswordError").textContent = "";
  openModal("changePasswordModal");
});

document.getElementById("changePasswordSubmit").addEventListener("click", async () => {
  const oldPw = document.getElementById("oldPasswordInput").value;
  const newPw = document.getElementById("newPasswordInput").value;
  try {
    await invoke("set_password", { oldPassword: oldPw, newPassword: newPw });
    closeModal("changePasswordModal");
    showToast(newPw ? "Пароль обновлён" : "Защита паролем отключена");
  } catch (err) {
    document.getElementById("changePasswordError").textContent = String(err);
  }
});

// ---------- Настройки ----------
document.getElementById("settingsBtn").addEventListener("click", () => {
  document.getElementById("appNameInput").value = state.config.app_name || "LAUNCHER";
  document.getElementById("appLogoInput").value = state.config.app_logo || "L";
  document.getElementById("minimizeToggleInput").checked = state.config.minimize_on_launch !== false;
  openModal("settingsModal");
});

document.getElementById("settingsSubmit").addEventListener("click", async () => {
  const name = document.getElementById("appNameInput").value.trim() || "LAUNCHER";
  const logo = document.getElementById("appLogoInput").value.trim() || "L";
  const minimize = document.getElementById("minimizeToggleInput").checked;

  state.config.app_name = name;
  state.config.app_logo = logo;
  state.config.minimize_on_launch = minimize;

  await persist();
  await applyBranding();
  closeModal("settingsModal");
  showToast("Настройки сохранены");
});

// ---------- Экспорт/Импорт ----------
document.getElementById("exportConfigBtn").addEventListener("click", async () => {
  try {
    const path = await invoke("export_config");
    showToast("Конфигурация экспортирована: " + path);
  } catch (err) {
    showToast("Ошибка экспорта: " + err);
  }
});

document.getElementById("importConfigBtn").addEventListener("click", async () => {
  try {
    await invoke("import_config");
    await loadConfig();
    showToast("Конфигурация импортирована");
  } catch (err) {
    showToast("Ошибка импорта: " + err);
  }
});

// ---------- Drag & Drop (мышь, pointer-based) ----------
let dragState = null;
let dropIndex = -1;
let suppressNextClick = 0;

function clearDropMarkers() {
  dropIndex = -1;
  document.querySelectorAll(".tile.drop-before, .tile.drop-after").forEach((el) =>
    el.classList.remove("drop-before", "drop-after")
  );
  document.getElementById("buttonGrid").classList.remove("drop-here");
  document.querySelectorAll(".group-item.drop-target").forEach((el) =>
    el.classList.remove("drop-target")
  );
}

function getDropIndex(grid, x, y) {
  const tiles = [...grid.querySelectorAll(".tile:not(.dragging)")];
  for (let i = 0; i < tiles.length; i++) {
    const r = tiles[i].getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) {
      if (x < r.left + r.width / 2) return i;
    } else if (y < r.top) {
      return i;
    }
  }
  return tiles.length;
}

function markDropIndex(grid, idx) {
  if (idx === dropIndex) return;
  clearDropMarkers();
  dropIndex = idx;
  const tiles = [...grid.querySelectorAll(".tile:not(.dragging)")];
  if (tiles.length === 0) {
    grid.classList.add("drop-here");
  } else if (idx === 0) {
    tiles[0].classList.add("drop-before");
  } else if (idx >= tiles.length) {
    tiles[tiles.length - 1].classList.add("drop-after");
  } else {
    tiles[idx].classList.add("drop-before");
  }
}

function tileGhostHtml(btn) {
  const icon = btn.icon && !isImagePath(btn.icon) ? btn.icon : "▶";
  return `<span class="drag-ghost-icon">${escapeHtml(icon)}</span><span class="drag-ghost-name">${escapeHtml(btn.name)}</span>`;
}

function groupGhostHtml(g) {
  return `<span class="drag-ghost-icon">${escapeHtml((g.name || "G").slice(0, 1))}</span><span class="drag-ghost-name">${escapeHtml(g.name)}</span>`;
}

function startDrag(type, id, fromGroupId, x, y, sourceEl, ghostHtml) {
  cancelDrag();
  dragState = { type, id, fromGroupId, x, y, active: false, sourceEl, ghost: null };
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.innerHTML = ghostHtml;
  ghost.style.display = "none";
  document.body.appendChild(ghost);
  dragState.ghost = ghost;
}

function cancelDrag() {
  const d = dragState;
  if (!d) return;
  if (d.ghost) d.ghost.remove();
  if (d.sourceEl) d.sourceEl.classList.remove("dragging");
  document.body.classList.remove("dragging");
  clearDropMarkers();
  dragState = null;
}

function updateDrag(x, y) {
  const d = dragState;
  if (!d) return;
  if (!d.active) {
    if (Math.hypot(x - d.x, y - d.y) < 5) return;
    d.active = true;
    d.ghost.style.display = "block";
    if (d.sourceEl) d.sourceEl.classList.add("dragging");
    document.body.classList.add("dragging");
  }
  const gw = d.ghost.offsetWidth;
  const gh = d.ghost.offsetHeight;
  d.ghost.style.left = Math.round(x - gw / 2) + "px";
  d.ghost.style.top = Math.round(y - gh - 14) + "px";
  highlightDropTarget(x, y);
}

function highlightDropTarget(x, y) {
  clearDropMarkers();
  const el = document.elementFromPoint(x, y);
  if (!el || !dragState || !dragState.active) return;
  if (dragState.type === "button") {
    const groupItem = el.closest(".group-item");
    if (groupItem && groupItem.dataset.groupId !== dragState.fromGroupId) {
      groupItem.classList.add("drop-target");
      return;
    }
    const grid = document.getElementById("buttonGrid");
    if (grid && grid.contains(el) && !state.searchQuery.trim()) {
      markDropIndex(grid, getDropIndex(grid, x, y));
    }
  } else if (dragState.type === "group") {
    const groupItem = el.closest(".group-item");
    if (groupItem && groupItem.dataset.groupId !== dragState.id) {
      groupItem.classList.add("drop-target");
    }
  }
}

async function finishDrag(x, y) {
  const d = dragState;
  if (!d) return;
  let didDrop = false;
  if (d.active) {
    const el = document.elementFromPoint(x, y);
    if (el) {
      const groups = state.config.groups;
      if (d.type === "button") {
        const groupItem = el.closest(".group-item");
        if (groupItem) {
          const fromGroup = groups.find((gg) => gg.id === d.fromGroupId);
          const btn = fromGroup && fromGroup.buttons.find((b) => b.id === d.id);
          const targetGroup = groups.find((gg) => gg.id === groupItem.dataset.groupId);
          if (btn && fromGroup && targetGroup) {
            fromGroup.buttons = fromGroup.buttons.filter((b) => b.id !== btn.id);
            targetGroup.buttons.push(btn);
            state.activeGroupId = targetGroup.id;
            didDrop = true;
          }
        } else {
          const grid = document.getElementById("buttonGrid");
          if (grid && grid.contains(el) && !state.searchQuery.trim()) {
            const fromGroup = groups.find((gg) => gg.id === d.fromGroupId);
            const btn = fromGroup && fromGroup.buttons.find((b) => b.id === d.id);
            const targetGroup = activeGroup();
            if (btn && fromGroup && targetGroup) {
              const oldIdx = fromGroup.buttons.indexOf(btn);
              fromGroup.buttons.splice(oldIdx, 1);
              const insertIdx = Math.min(getDropIndex(grid, x, y), targetGroup.buttons.length);
              targetGroup.buttons.splice(insertIdx, 0, btn);
              state.activeGroupId = targetGroup.id;
              didDrop = true;
            }
          }
        }
      } else if (d.type === "group") {
        const groupItem = el.closest(".group-item");
        if (groupItem && groupItem.dataset.groupId !== d.id) {
          const dragGroup = groups.find((gg) => gg.id === d.id);
          const target = groups.find((gg) => gg.id === groupItem.dataset.groupId);
          if (dragGroup && target) {
            const dragIdx = groups.findIndex((gg) => gg.id === d.id);
            const targetIdx = groups.findIndex((gg) => gg.id === target.id);
            const rect = groupItem.getBoundingClientRect();
            const before = y < rect.top + rect.height / 2;
            groups.splice(dragIdx, 1);
            const newTargetIdx = dragIdx < targetIdx ? targetIdx - 1 : targetIdx;
            groups.splice(newTargetIdx + (before ? 0 : 1), 0, dragGroup);
            didDrop = true;
          }
        }
      }
    }
  }
  cancelDrag();
  if (d.active) suppressNextClick = Date.now();
  if (didDrop) {
    await persist();
    render();
  }
}

document.addEventListener("mousemove", (e) => {
  updateDrag(e.clientX, e.clientY);
});
document.addEventListener("mouseup", (e) => {
  finishDrag(e.clientX, e.clientY);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dragState) cancelDrag();
});
document.addEventListener("click", (e) => {
  if (Date.now() - suppressNextClick < 500) {
    suppressNextClick = 0;
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

// ---------- Инициализация ----------
updateLockUI();
loadConfig();
