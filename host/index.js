// dsh-composer-tokens — host half.
// Pure UI plugin: the empty apply exists so the package appears in the host
// Loader (cordis.yml / profile patch row); the browser half ships via
// exports["./client"], discovered through the package.json dsh.client
// declaration (mirrors @deepseek-ai/dsh-client-ui-goal lib/index.js).
export function apply() {}