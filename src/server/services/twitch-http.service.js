async function baseTwitchApiRequest(url, config, options = {}, callbacks = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Client-Id": config.clientId,
      Authorization: `Bearer ${config.accessToken}`,
      ...(options.body
        ? { "Content-Type": "application/json; charset=utf-8" }
        : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`Twitch API ${res.status}: ${text}`);
    error.status = res.status;

    if (res.status === 401 && typeof callbacks.onUnauthorized === "function") {
      callbacks.onUnauthorized(error.message);
    }

    throw error;
  }

  if (res.status === 204) {
    return null;
  }

  const contentType = String(
    res.headers.get("content-type") || "",
  ).toLowerCase();
  if (!contentType.includes("application/json")) {
    return null;
  }

  return res.json();
}

async function baseTwitchRequest(url, config, options = {}, dependencies = {}) {
  const fallback =
    typeof dependencies.getFallbackConfig === "function"
      ? dependencies.getFallbackConfig()
      : {};

  const normalizedConfig = {
    clientId: String(config?.clientId || fallback.clientId || "").trim(),
    accessToken: String(
      config?.accessToken || fallback.accessToken || "",
    ).trim(),
  };

  const apiRequest = dependencies.apiRequest || baseTwitchApiRequest;
  return apiRequest(
    url,
    normalizedConfig,
    options,
    dependencies.callbacks || {},
  );
}

module.exports = {
  baseTwitchApiRequest,
  baseTwitchRequest,
};
