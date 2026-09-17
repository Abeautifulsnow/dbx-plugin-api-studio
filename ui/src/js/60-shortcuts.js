/* ==== Global keyboard shortcuts ====
   Send Ctrl/Cmd+Enter · Save Ctrl/Cmd+S · New Request Ctrl/Cmd+N ·
   focus URL Ctrl/Cmd+L · format JSON Shift+Alt+F */

function initShortcuts() {
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === "Enter") {
      event.preventDefault();
      RequestFlow.sendOrCancel();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      Editor.saveCurrent();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      Editor.newRequest();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      Editor.urlInput.focus();
      Editor.urlInput.select();
      return;
    }
    if (event.shiftKey && event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      Editor.formatBody(true);
    }
  });
}
