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
  var state = { sessionId: "", todos: [], version: 0, events: null };

  function showNotice(message, error) {
    notice.textContent = message || "";
    notice.className = error ? "notice error" : "notice";
  }

  function api(path, options) {
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          var error = new Error(body.error || "Request failed");
          error.status = response.status;
          error.body = body;
          throw error;
        }
        return body;
      });
    });
  }

  function render() {
    list.replaceChildren();
    var completed = 0;
    state.todos.forEach(function (todo) {
      if (todo.status === "completed") completed += 1;
      var item = document.createElement("li");
      item.className = "todo-item " + todo.status;
      var content = document.createElement("div");
      content.className = "todo-content";
      var id = document.createElement("span");
      id.className = "todo-id";
      id.textContent = todo.id;
      var text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = todo.content;
      content.append(id, text);
      var actions = document.createElement("div");
      actions.className = "todo-actions";
      var status = document.createElement("button");
      status.type = "button";
      status.textContent = todo.status === "completed" ? "Reopen" : "Complete";
      status.addEventListener("click", function () { save(state.todos.map(function (item) { return item.id === todo.id ? Object.assign({}, item, { status: item.status === "completed" ? "pending" : "completed" }) : item; })); });
      var edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", function () {
        var value = window.prompt("Edit todo", todo.content);
        if (value !== null && value.trim()) save(state.todos.map(function (item) { return item.id === todo.id ? Object.assign({}, item, { content: value.trim() }) : item; }));
      });
      var remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", function () { save(state.todos.filter(function (item) { return item.id !== todo.id; })); });
      actions.append(status, edit, remove);
      item.append(content, actions);
      list.append(item);
    });
    emptyState.hidden = state.todos.length !== 0;
    summary.textContent = completed + " of " + state.todos.length + " complete";
  }

  function save(todos) {
    return api("/api/sessions/" + encodeURIComponent(state.sessionId) + "/todos", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todos: todos, version: state.version })
    }).then(function (body) {
      state.todos = body.todos; state.version = body.version; render(); showNotice("Saved");
    }).catch(function (error) {
      if (error.status === 409 && error.body) { state.todos = error.body.todos || []; state.version = error.body.version || 0; render(); showNotice("Todo changed elsewhere. Showing the server version.", true); }
      else showNotice(error.message, true);
    });
  }

  function connectEvents() {
    if (state.events) state.events.close();
    state.events = new EventSource("/api/sessions/" + encodeURIComponent(state.sessionId) + "/todos/events");
    state.events.onopen = function () { connectionStatus.textContent = "Live"; connectionStatus.className = "status-dot live"; };
    state.events.onerror = function () { connectionStatus.textContent = "Reconnecting"; connectionStatus.className = "status-dot warning"; };
    state.events.addEventListener("todo_updated", function (event) { var data = JSON.parse(event.data); state.todos = data.todos; state.version = data.version; render(); });
  }

  function selectSession(id) {
    state.sessionId = id;
    history.replaceState(null, "", "?session=" + encodeURIComponent(id));
    return api("/api/sessions/" + encodeURIComponent(id) + "/todos").then(function (body) { state.todos = body.todos; state.version = body.version; render(); connectEvents(); });
  }

  addForm.addEventListener("submit", function (event) { event.preventDefault(); var value = addInput.value.trim(); if (!value) return; save(state.todos.concat([{ id: "todo-" + Date.now(), content: value, status: "pending" }])).then(function () { addInput.value = ""; }); });
  clearButton.addEventListener("click", function () { if (state.todos.length) save([]); });
  sessionSelect.addEventListener("change", function () { selectSession(sessionSelect.value); });

  api("/api/sessions").then(function (body) {
    var sessions = body.sessions || [];
    sessionSelect.replaceChildren();
    sessions.forEach(function (session) { var option = document.createElement("option"); option.value = session.id; option.textContent = session.id; sessionSelect.append(option); });
    if (!sessions.length) { showNotice("No sessions available", true); return; }
    var requested = new URLSearchParams(window.location.search).get("session");
    var selected = sessions.some(function (session) { return session.id === requested; }) ? requested : sessions[sessions.length - 1].id;
    sessionSelect.value = selected;
    selectSession(selected);
  }).catch(function (error) { showNotice(error.message, true); });
}());
