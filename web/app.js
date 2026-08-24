(function () {
  "use strict";
  var sessionSelect = document.getElementById("session-select");
  var connectionStatus = document.getElementById("connection-status");
  var summary = document.getElementById("completion-summary");
  var list = document.getElementById("todo-list");
  var emptyState = document.getElementById("empty-state");
  var addForm = document.getElementById("add-form");
  var addInput = document.getElementById("add-input");
  var clearButton = document.getElementById("clear-button");
  var notice = document.getElementById("notice");
  var statusTemplate = document.getElementById("todo-status-options");
  var state = { sessionId: "", todos: [], version: 0, events: null, generation: 0, reconnectTimer: null };
  function showNotice(message, error) { notice.textContent = message || ""; notice.className = error ? "notice error" : "notice"; }
  function current(sessionId, generation) { return state.sessionId === sessionId && state.generation === generation; }
  function clearReconnectTimer() { if (state.reconnectTimer !== null) { window.clearTimeout(state.reconnectTimer); state.reconnectTimer = null; } }
  function api(path, options) { return fetch(path, options).then(function (response) { return response.json().catch(function () { return {}; }).then(function (body) { if (!response.ok) { var error = new Error(body.error || "Request failed"); error.status = response.status; error.body = body; throw error; } return body; }); }); }
  function nextTodoId(todos) { var n = 1; var used = {}; todos.forEach(function (todo) { used[todo.id] = true; }); while (used["todo-" + n]) n += 1; return "todo-" + n; }
  function statusOptions(select) { select.replaceChildren(); select.append(statusTemplate.content.cloneNode(true)); }
  function render() {
    list.replaceChildren(); var completed = 0;
    state.todos.forEach(function (todo) {
      if (todo.status === "completed") completed += 1;
      var item = document.createElement("li"); item.className = "todo-item " + todo.status;
      var content = document.createElement("div"); content.className = "todo-content";
      var id = document.createElement("span"); id.className = "todo-id"; id.textContent = todo.id;
      var text = document.createElement("span"); text.className = "todo-text"; text.textContent = todo.content; content.append(id, text);
      var actions = document.createElement("div"); actions.className = "todo-actions";
      var status = document.createElement("select"); status.setAttribute("aria-label", "Todo status"); statusOptions(status); status.value = todo.status;
      status.addEventListener("change", function () { var next = state.todos.map(function (entry) { return entry.id === todo.id ? Object.assign({}, entry, { status: status.value }) : (status.value === "in_progress" && entry.status === "in_progress" ? Object.assign({}, entry, { status: "pending" }) : entry); }); save(next); });
      var edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.addEventListener("click", function () { var value = window.prompt("Edit todo", todo.content); if (value !== null && value.trim()) save(state.todos.map(function (entry) { return entry.id === todo.id ? Object.assign({}, entry, { content: value.trim() }) : entry; })); });
      var remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Delete"; remove.addEventListener("click", function () { save(state.todos.filter(function (entry) { return entry.id !== todo.id; })); });
      actions.append(status, edit, remove); item.append(content, actions); list.append(item);
    });
    emptyState.hidden = state.todos.length !== 0; summary.textContent = completed + " of " + state.todos.length + " complete";
  }
  function save(todos) {
    var sessionId = state.sessionId; var generation = state.generation; var requestedVersion = state.version;
    return api("/api/sessions/" + encodeURIComponent(sessionId) + "/todos", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ todos: todos, version: requestedVersion }) }).then(function (body) {
      if (!current(sessionId, generation) || typeof body.version !== "number" || body.version < state.version) return;
      state.todos = body.todos; state.version = body.version; render(); showNotice("Saved");
    }).catch(function (error) {
      if (!current(sessionId, generation)) return;
      if (error.status === 409 && error.body && typeof error.body.version === "number" && error.body.version >= state.version) { state.todos = error.body.todos || []; state.version = error.body.version; render(); showNotice("Todo changed elsewhere. Showing the server version.", true); } else showNotice(error.message, true);
    });
  }
  function connectEvents(sessionId, generation) {
    if (!current(sessionId, generation)) return;
    clearReconnectTimer(); if (state.events) { state.events.close(); state.events = null; }
    var events = new EventSource("/api/sessions/" + encodeURIComponent(sessionId) + "/todos/events"); state.events = events;
    events.onopen = function () { if (!current(sessionId, generation)) return; connectionStatus.textContent = "Live"; connectionStatus.className = "status-dot live"; };
    events.onerror = function () { if (!current(sessionId, generation)) { events.close(); return; } events.close(); if (state.events === events) state.events = null; connectionStatus.textContent = "Reconnecting"; connectionStatus.className = "status-dot warning"; clearReconnectTimer(); state.reconnectTimer = window.setTimeout(function () { state.reconnectTimer = null; connectEvents(sessionId, generation); }, 1000); };
    events.addEventListener("todo_updated", function (event) { if (!current(sessionId, generation)) return; var data = JSON.parse(event.data); if (typeof data.version !== "number" || data.version < state.version) return; state.todos = data.todos; state.version = data.version; render(); });
  }
  function selectSession(id) {
    state.generation += 1; var generation = state.generation; clearReconnectTimer(); if (state.events) { state.events.close(); state.events = null; }
    state.sessionId = id; state.todos = []; state.version = 0; connectionStatus.textContent = "Loading"; connectionStatus.className = "status-dot"; history.replaceState(null, "", "?session=" + encodeURIComponent(id));
    return api("/api/sessions/" + encodeURIComponent(id) + "/todos").then(function (body) { if (!current(id, generation)) return; state.todos = body.todos; state.version = body.version; render(); connectEvents(id, generation); }).catch(function (error) { if (current(id, generation)) showNotice(error.message, true); });
  }
  addForm.addEventListener("submit", function (event) { event.preventDefault(); var value = addInput.value.trim(); if (!value) return; save(state.todos.concat([{ id: nextTodoId(state.todos), content: value, status: "pending" }])).then(function () { if (addInput.value.trim() === value) addInput.value = ""; }); });
  clearButton.addEventListener("click", function () { if (state.todos.length) save([]); });
  sessionSelect.addEventListener("change", function () { selectSession(sessionSelect.value); });
  api("/api/sessions").then(function (body) { var sessions = body.sessions || []; sessionSelect.replaceChildren(); sessions.forEach(function (session) { var option = document.createElement("option"); option.value = session.id; option.textContent = session.id; sessionSelect.append(option); }); if (!sessions.length) { showNotice("No sessions available", true); return; } var requested = new URLSearchParams(window.location.search).get("session"); var selected = sessions.some(function (session) { return session.id === requested; }) ? requested : sessions[sessions.length - 1].id; sessionSelect.value = selected; selectSession(selected); }).catch(function (error) { showNotice(error.message, true); });
}());
