const axios = require("axios");

const {
  GRAPH_TENANT_ID,
  GRAPH_CLIENT_ID,
  GRAPH_CLIENT_SECRET,
  GRAPH_SENDER_EMAIL,
} = process.env;

if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET || !GRAPH_SENDER_EMAIL) {
  console.warn(
    "⚠️ Faltan variables Graph en .env. Se requieren: GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_SENDER_EMAIL"
  );
}

// Cache simple del token
let cachedToken = null;
let cachedTokenExp = 0; // epoch seconds

async function getGraphToken() {
  const now = Math.floor(Date.now() / 1000);

  // Renueva 60s antes de expirar
  if (cachedToken && cachedTokenExp && now < cachedTokenExp - 60) {
    return cachedToken;
  }

  const url = `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append("client_id", GRAPH_CLIENT_ID);
  params.append("client_secret", GRAPH_CLIENT_SECRET);
  params.append("grant_type", "client_credentials");
  params.append("scope", "https://graph.microsoft.com/.default");

  let res;
  try {
    res = await axios.post(url, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    throw new Error(
      `Graph token fallo (${status || "?"}): ${JSON.stringify(data || e.message)}`
    );
  }

  const accessToken = res.data.access_token;
  const expiresIn = Number(res.data.expires_in || 3600);

  cachedToken = accessToken;
  cachedTokenExp = now + expiresIn;

  return accessToken;
}

function toRecipientsArray(to) {
  // Acepta array o string separado por comas
  if (!to) return [];
  if (Array.isArray(to)) return to.map((e) => String(e).trim()).filter(Boolean);
  return String(to)
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

function normalizeAttachments(attachments) {
  const arr = Array.isArray(attachments) ? attachments : [];

  return arr.map((a) => {
    const filename = a.filename || a.name;
    const contentType = a.contentType || "application/pdf";
    const contentBytes = a.content || a.contentBytes;

    if (!filename || !contentBytes) {
      throw new Error("Adjunto inválido: se requiere filename y content (base64)");
    }

    // Debe ser base64 puro, sin prefijo "data:application/pdf;base64,"
    const cleanContentBytes = String(contentBytes).includes("base64,")
      ? String(contentBytes).split("base64,").pop()
      : String(contentBytes);

    return {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: filename,
      contentType,
      contentBytes: cleanContentBytes,
    };
  });
}

async function enviarCorreoGraph({ to, subject, html, attachments = [] }) {
  if (!subject || !html) {
    throw new Error("Faltan campos: subject y html son obligatorios");
  }

  const recipients = toRecipientsArray(to);
  if (!recipients.length) {
    throw new Error("No hay destinatarios (to) para enviarCorreoGraph");
  }

  const token = await getGraphToken();

  const message = {
    subject,
    body: {
      contentType: "HTML",
      content: html,
    },
    toRecipients: recipients.map((email) => ({
      emailAddress: { address: email },
    })),
  };

  const normalized = normalizeAttachments(attachments);
  if (normalized.length) {
    message.attachments = normalized;
  }

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
    GRAPH_SENDER_EMAIL
  )}/sendMail`;

  try {
    await axios.post(
      url,
      { message, saveToSentItems: true },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    throw new Error(
      `Graph sendMail fallo (${status || "?"}): ${JSON.stringify(data || e.message)}`
    );
  }

  return { ok: true };
}

module.exports = { enviarCorreoGraph };
