// Forked between Electron's main process and the bundled Next standalone
// server (see main.js startServer). Its single job: make sure the server can
// never outlive the app. `will-quit` only covers graceful exits — if the main
// process is SIGKILLed / OOM-killed / segfaults, the fork()ed child used to
// survive as an orphan, keeping flix.db open and racing the next launch's
// server on the same database. The IPC channel fork() opens closes on ANY
// parent death, which fires "disconnect" here.
//
// Shipped by scripts/prepare-desktop.mjs NEXT TO server.js (never inside the
// asar: a child process running under ELECTRON_RUN_AS_NODE must not depend on
// asar path support). The server entry to load comes in argv[2].

process.on("disconnect", () => process.exit(0));

const { pathToFileURL } = require("url");
// Dynamic import handles the server entry whether Next emits it as CJS or ESM.
import(pathToFileURL(process.argv[2]).href).catch((error) => {
  console.error("[flix server-shim] failed to start server:", error);
  process.exit(1);
});
