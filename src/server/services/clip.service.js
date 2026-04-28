/**
 * Clip Service
 * Gerencia criação de clips da Twitch via API ou comando no chat
 */

function parseClipDuration(value, fallback = 30) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) {
    return fallback;
  }

  return Math.min(60, Math.max(5, Math.round(duration)));
}

async function createTwitchClip(
  config,
  requestedDuration,
  title = "",
  twitchRequest,
) {
  const duration = parseClipDuration(requestedDuration, 30);
  const clipTitle = String(title || "")
    .trim()
    .slice(0, 140);
  const query = new URLSearchParams({
    broadcaster_id: String(config.broadcasterId || "").trim(),
    duration: String(duration),
  });

  if (clipTitle) {
    query.set("title", clipTitle);
  }

  const response = await twitchRequest(
    `https://api.twitch.tv/helix/clips?${query.toString()}`,
    {
      clientId: config.clientId,
      accessToken: config.accessToken,
    },
    {
      method: "POST",
    },
  );

  const createdClip = response?.data?.[0] || null;
  return {
    clipId: String(createdClip?.id || "").trim(),
    editUrl: String(createdClip?.edit_url || "").trim(),
    duration,
  };
}

async function fetchBroadcasterLiveStream(config, twitchRequest) {
  const url = new URL("https://api.twitch.tv/helix/streams");
  url.searchParams.set("user_id", String(config?.broadcasterId || "").trim());

  const response = await twitchRequest(
    url.toString(),
    {
      clientId: config.clientId,
      accessToken: config.accessToken,
    },
    {
      method: "GET",
    },
  );

  const stream = Array.isArray(response?.data)
    ? response.data[0] || null
    : null;
  return {
    isLive: Boolean(stream),
    title: String(stream?.title || "").trim(),
  };
}

function buildClipCommandTitle(senderName, streamTitle, argsText) {
  const sender = String(senderName || "viewer").trim() || "viewer";
  const args = String(argsText || "").trim();
  const liveTitle = String(streamTitle || "live").trim() || "live";

  if (args) {
    return `${sender} - ${args}`;
  }

  return `${sender} - ${liveTitle}`;
}

async function executeClipSystemCommand(
  config,
  chatContext,
  { sendChatMessage, twitchRequest },
) {
  if (!config?.clientId || !config?.broadcasterId || !config?.accessToken) {
    await sendChatMessage(
      config,
      "Nao consegui clipar agora: Twitch nao conectada corretamente.",
    );
    return;
  }

  const streamStatus = await fetchBroadcasterLiveStream(config, twitchRequest);
  if (!streamStatus.isLive) {
    await sendChatMessage(
      config,
      "Nao da pra clipar agora porque a live esta offline.",
    );
    return;
  }

  const clipTitle = buildClipCommandTitle(
    chatContext?.sender,
    streamStatus.title,
    chatContext?.args,
  );

  const createdClip = await createTwitchClip(
    config,
    30,
    clipTitle,
    twitchRequest,
  );
  const clipUrl = createdClip.clipId
    ? `https://clips.twitch.tv/${createdClip.clipId}`
    : createdClip.editUrl;

  await sendChatMessage(
    config,
    `@${chatContext?.sender || "viewer"} clipou (${createdClip.duration}s): ${clipUrl}`,
  );
}

module.exports = {
  parseClipDuration,
  createTwitchClip,
  fetchBroadcasterLiveStream,
  buildClipCommandTitle,
  executeClipSystemCommand,
};
