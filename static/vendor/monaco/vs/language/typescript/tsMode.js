/* session-mesh: stand-in for Monaco's TypeScript language service, left out
   of the vendored build (5.6 MB). The read-only code viewer only needs
   highlighting, which the basic "typescript"/"javascript" grammars provide;
   these no-ops satisfy monaco.contribution's lazy setup call. */
define("vs/language/typescript/tsMode", ["require", "exports"], function (require, exports) {
  "use strict";
  Object.defineProperty(exports, "__esModule", { value: true });
  const none = function () { return { dispose: function () {} }; };
  exports.setupTypeScript = none;
  exports.setupJavaScript = none;
  exports.getTypeScriptWorker = function () { return Promise.reject(new Error("no TypeScript service")); };
  exports.getJavaScriptWorker = exports.getTypeScriptWorker;
});
