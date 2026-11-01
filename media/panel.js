(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var root = document.getElementById('root');

  root.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || !root.contains(target)) {
      return;
    }
    var action = target.getAttribute('data-action');
    if (action === 'selectTurn') {
      vscode.postMessage({ action: action, id: target.getAttribute('data-id') });
    } else if (action === 'refresh' || action === 'chooseSession' || action === 'autoSession') {
      vscode.postMessage({ action: action });
    }
  });

  root.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') {
      return;
    }
    var target = event.target instanceof Element ? event.target.closest('tr[data-action="selectTurn"]') : null;
    if (target && root.contains(target)) {
      vscode.postMessage({ action: 'selectTurn', id: target.getAttribute('data-id') });
    }
  });

  root.addEventListener('change', function (event) {
    var target = event.target;
    if (target instanceof HTMLSelectElement && target.getAttribute('data-action') === 'selectSession') {
      vscode.postMessage({ action: 'selectSession', id: target.value });
    }
  });

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'render' && typeof message.html === 'string') {
      root.innerHTML = message.html;
    } else if (message.type === 'tick' && typeof message.text === 'string') {
      var nodes = document.querySelectorAll('[data-live-elapsed]');
      for (var index = 0; index < nodes.length; index += 1) {
        nodes[index].textContent = message.text;
      }
    }
  });

  vscode.postMessage({ action: 'ready' });
})();
