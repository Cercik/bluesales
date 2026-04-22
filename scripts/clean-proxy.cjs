const { spawnSync } = require("node:child_process");
require("dotenv").config();

if (process.env.NODE_ENV === "production" && process.env.ALLOW_PROD_PROXY_CLEAN !== "true") {
  throw new Error("Limpieza de proxy bloqueada en produccion. Define ALLOW_PROD_PROXY_CLEAN=true para continuar.");
}

const proxyVars = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "GIT_HTTP_PROXY",
  "GIT_HTTPS_PROXY",
  "git_http_proxy",
  "git_https_proxy"
];

for (const key of proxyVars) {
  delete process.env[key];
}

if (process.platform === "win32") {
  const psCommand = `
    $ErrorActionPreference = "Stop"
    $vars = @(${proxyVars.map((v) => `'${v}'`).join(",")})
    $userDenied = @()
    foreach ($v in $vars) {
      try {
        [Environment]::SetEnvironmentVariable($v, $null, "User")
      } catch {
        $userDenied += $v
      }
      try {
        [Environment]::SetEnvironmentVariable($v, $null, "Process")
      } catch {
      }
    }
    if ($userDenied.Count -gt 0) {
      Write-Output ("No se pudo limpiar en User (sin permisos): " + ($userDenied -join ", "))
      Write-Output "Se limpio igual en Process para esta sesion."
    } else {
      Write-Output "Variables proxy limpiadas en User/Process."
    }
  `;
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
    { stdio: "inherit" }
  );
  if (result.status !== 0) process.exit(result.status || 1);
} else {
  console.log("Se limpiaron variables proxy en la sesion actual.");
}

spawnSync("git", ["config", "--global", "--unset", "http.proxy"], { stdio: "ignore" });
spawnSync("git", ["config", "--global", "--unset", "https.proxy"], { stdio: "ignore" });

console.log("Proxy de Git (global) limpiado cuando existia.");
