
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { enviarCorreoGraph } = require("./enviarCorreoGraph");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { QueryCommand } = require("@aws-sdk/lib-dynamodb");


const port = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// ============================
// CONFIG
// ============================
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const DDB_TABLE = process.env.DDB_TABLE || "aval_cache";
const CACHE_MONTHS = Number(process.env.CACHE_MONTHS || 1);

// ============================
// HISTORIAL PRECALIFICACIONES
// ============================
const DDB_PRECAL_HISTORY_TABLE = process.env.DDB_PRECAL_HISTORY;
const PRECAL_HISTORY_MAX = Number(process.env.PRECAL_HISTORY_MAX || 200);

// DESTINATARIOS FIJOS (hardcodeados)
const EMAIL_RECIPIENTS = [
  "jandrade@tactiqaec.com",
  "pmantilla@tactiqaec.com",
  "jhidalgo@tactiqaec.com",
  "dmartinez@tactiqaec.com"
];

// ============================
// DynamoDB Client
// ============================
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));

// ============================
// HELPERS
// ============================
function addCalendarMonths(date, months = 1) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // ajuste natural de Date si el mes no tiene ese día (ok para “mes calendario”)
  if (d.getDate() < day) {}
  return d;
}

function getCedulaFromBody(body) {
  const codigoProducto = body?.request?.codigoProducto;
  const datosEntrada = Array.isArray(body?.request?.datosEntrada) ? body.request.datosEntrada : [];
  const cedula = (
    datosEntrada.find((x) => x?.clave === "identificacionSujeto")?.valor || ""
  )
    .toString()
    .trim();

  return { cedula, codigoProducto };
}

function buildPk(cedula, codigoProducto) {
  return `${cedula}#${codigoProducto}`;
}

function buildHistPk(userId, epochMs = Date.now()) {
  return `HIST#${userId}#${epochMs}`;
}

// ============================
// GRAPH + ONEDRIVE (Excel)
// ============================

// Obtiene token app-only (client credentials)
async function getGraphAppToken() {
  const tenant = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!tenant || !clientId || !clientSecret) {
    throw new Error("Faltan GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET en Render");
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", "https://graph.microsoft.com/.default");
  params.append("grant_type", "client_credentials");

  const r = await axios.post(tokenUrl, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return r.data.access_token;
}

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Resuelve un share URL de OneDrive/SharePoint a driveId/itemId
async function resolveDriveItemFromShareUrl(accessToken, shareUrl) {
  const encoded = base64UrlEncode(shareUrl);
  const url = `https://graph.microsoft.com/v1.0/shares/u!${encoded}/driveItem`;

  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return {
    driveId: r.data.parentReference?.driveId,
    itemId: r.data.id,
  };
}

// Agrega una fila a una tabla de Excel (debe existir la tabla)
async function appendRowToExcel(accessToken, rowValues) {
  const shareUrl = process.env.ONEDRIVE_EXCEL_SHARE_URL;
  const tableName = process.env.ONEDRIVE_TABLE_NAME || "tbl_precalificaciones";

  if (!shareUrl) {
    throw new Error("Falta ONEDRIVE_EXCEL_SHARE_URL en Render");
  }

  const { driveId, itemId } = await resolveDriveItemFromShareUrl(accessToken, shareUrl);

  if (!driveId || !itemId) {
    throw new Error("No pude resolver driveId/itemId desde ONEDRIVE_EXCEL_SHARE_URL");
  }

  const url =
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}` +
    `/workbook/tables/${tableName}/rows/add`;

  await axios.post(
    url,
    { values: [rowValues] },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ============================
// USUARIOS 
// ============================

function buildUser(id, userEnvName, passEnvName, role) {
  const username = (process.env[userEnvName] || "").toString().trim();
  const password = (process.env[passEnvName] || "").toString();

  if (!username || !password) return null;

  return {
    id,
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role,
  };
}

const users = [
  buildUser(1, "ADMIN_USER", "ADMIN_PASSWORD", "admin"),
  buildUser(2, "COMERCIAL_USER", "COMERCIAL_PASSWORD", "comercial"),
  buildUser(3, "OPERATIVO_USER", "OPERATIVO_PASSWORD", "operativo"),
  buildUser(4, "GERENTE_USER", "GERENTE_PASSWORD", "manager"),
].filter(Boolean);

// ============================
// JWT Middleware
// ============================
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.sendStatus(401);

  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// ============================
// LOGIN
// ============================
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const user = users.find((u) => u.username === username);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: "Credenciales inválidas" });
  }

  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "24h" }
  );

  res.json({ token });
});

// ============================
// PROXY AVAL + CACHE DYNAMODB
// ============================
app.post("/proxy", authenticateJWT, async (req, res) => {
  try {
    const { cedula, codigoProducto } = getCedulaFromBody(req.body);

    if (!cedula || !codigoProducto) {
      return res.status(400).json({
        error: "Faltan datos para cache (cedula o codigoProducto)",
      });
    }

    const now = new Date();
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const pk = buildPk(cedula, codigoProducto);

    // 1) Intentar cache
    try {
      const cached = await ddb.send(
        new GetCommand({
          TableName: DDB_TABLE,
          Key: { pk },
        })
      );

      if (
        cached?.Item?.payload &&
        typeof cached.Item.expiresAt === "number" &&
        cached.Item.expiresAt > nowEpoch
      ) {
        return res.json({
          ...cached.Item.payload,
          _cache: {
            hit: true,
            cedula,
            codigoProducto,
            expiresAt: cached.Item.expiresAt,
          },
        });
      }
    } catch (e) {
      console.warn(" DynamoDB GetItem falló, sigo al API:", e?.message || e);
    }

    // 2) Llamar API Aval
    const response = await axios.post(process.env.AVAL_URL, req.body, {
      headers: {
        Authorization:
          "Basic " + Buffer.from("WS-TAQTICA:&jg4I(iKGA").toString("base64"),
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
    });

    const apiData = response.data;

    // 3) Guardar cache (1 mes)
    const expiresAtDate = addCalendarMonths(now, CACHE_MONTHS);
    const expiresAt = Math.floor(expiresAtDate.getTime() / 1000);

    try {
      await ddb.send(
        new PutCommand({
          TableName: DDB_TABLE,
          Item: {
            pk,
            cedula,
            codigoProducto,
            createdAt: nowEpoch,
            expiresAt,
            payload: apiData,
          },
        })
      );
    } catch (e) {
      console.warn(" DynamoDB PutItem falló:", e?.message || e);
    }

    return res.json({
      ...apiData,
      _cache: {
        hit: false,
        cedula,
        codigoProducto,
        expiresAt,
      },
    });
  } catch (error) {
    console.error("Error en /proxy:", error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================
// ENVIAR CORREO (GRAPH)
// ============================
app.post("/enviarCorreo", authenticateJWT, async (req, res) => {
  try {
    const { subject, html, attachments } = req.body || {};

    if (!subject || !html) {
      return res.status(400).json({
        ok: false,
        message: "Faltan campos requeridos (subject, html)",
      });
    }

    // Validación ligera de adjuntos
    const safeAttachments = Array.isArray(attachments) ? attachments : [];
    for (const a of safeAttachments) {
      if (!a?.filename || !a?.content) {
        return res.status(400).json({
          ok: false,
          message: "Adjunto inválido: se requiere filename y content (base64)",
        });
      }
    }

    await enviarCorreoGraph({
      to: EMAIL_RECIPIENTS,
      subject,
      html,
      attachments: safeAttachments, // [{ filename, content(base64), contentType }]
    });

    return res.json({
      ok: true,
      message: "Correo enviado correctamente (Graph)",
      recipients: EMAIL_RECIPIENTS,
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const details = err?.response?.data || err?.message || String(err);

    console.error("Error Graph (detalle):", details);

    return res.status(status).json({
      ok: false,
      message: "Error enviando correo por Graph",
      details,
    });
  }
});

// ============================
// GUARDAR PRECALIFICACIÓN EN EXCEL (OneDrive)
// ============================
app.post("/precalificaciones/excel", authenticateJWT, async (req, res) => {
  try {
    const usuario = req.user?.username || "unknown";

    const {
      cedulaDeudor,
      nombreDeudor,
      cedulaConyuge,
      nombreConyuge,
      scoreDeudor,
      scoreConyuge,
      decisionFinal,
      monto,
      plazo,
      cuota,
      concesionario,
    } = req.body || {};

    if (!cedulaDeudor) {
      return res.status(400).json({
        ok: false,
        message: "Falta cedulaDeudor",
      });
    }

    const fecha = new Date().toLocaleString("es-EC");

    const accessToken = await getGraphAppToken();

    await appendRowToExcel(accessToken, [
      fecha,
      usuario,
      String(cedulaDeudor ?? ""),
      String(nombreDeudor ?? ""),
      String(cedulaConyuge ?? ""),
      String(nombreConyuge ?? ""),
      String(scoreDeudor ?? ""),
      String(scoreConyuge ?? ""),
      String(decisionFinal ?? ""),
      String(monto ?? ""),
      String(plazo ?? ""),
      String(cuota ?? ""),
      String(concesionario ?? ""),
    ]);

    return res.json({
      ok: true,
      message: "Precalificación guardada en Excel",
    });
  } catch (err) {
    const status = err?.response?.status || 500;
    const details = err?.response?.data || err?.message || String(err);

    console.error("Error Excel OneDrive (detalle):", details);

    return res.status(status).json({
      ok: false,
      message: "No se pudo escribir en el Excel",
      details,
    });
  }
});

// ============================
// HISTORIAL PRECALIFICACIONES (API)
// ============================

// Guardar un registro en historial
app.post("/precalificaciones/historial", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const username = req.user?.username || "unknown";
    if (!userId) return res.status(401).json({ ok: false, message: "No autenticado" });

    const safeBody = req.body && typeof req.body === "object" ? req.body : {};
    const createdAt = Date.now();
    const pk = buildHistPk(userId, createdAt);

    await ddb.send(
      new PutCommand({
        TableName: DDB_PRECAL_HISTORY_TABLE,
        Item: {
          pk,
          type: "precal_hist",
          userId: Number(userId),
          username,
          createdAt,
          data: safeBody,

          // ✅ Para consultar por usuario/fecha usando GSI
          // IMPORTANTE: tu índice gsi1 tiene sort key tipo STRING (S).
          // Date.now() es Number, así que guardamos como string (13 dígitos) para evitar Type mismatch.
          gsi1pk: `USER#${userId}`,
          gsi1sk: String(createdAt),
        },
      })
    );
    if (PRECAL_HISTORY_MAX > 0) {
      const { Items = [] } = await ddb.send(
        new QueryCommand({
          TableName: DDB_PRECAL_HISTORY_TABLE,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :u",
          ExpressionAttributeValues: {
            ":u": `USER#${userId}`,
          },
          ScanIndexForward: false, // más nuevas primero
          ProjectionExpression: "pk, gsi1sk",
        })
      );

      if (Items.length > PRECAL_HISTORY_MAX) {
        const toDelete = Items.slice(PRECAL_HISTORY_MAX);

        for (const it of toDelete) {
          await ddb.send(
            new DeleteCommand({
              TableName: DDB_PRECAL_HISTORY_TABLE,
              Key: { pk: it.pk },
            })
          );
        }
      }
    }

    // ✅ Tu respuesta normal (deja la tuya si ya existe)
    return res.json({ ok: true, pk, createdAt });
  } catch (err) {
    console.error("POST /precalificaciones/historial error:", err);
    return res.status(500).json({ ok: false, message: "Error guardando historial" });
  }
});


// Listar historial del usuario
app.get("/precalificaciones/historial", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "No autenticado" });

    const limit = Math.min(Number(req.query.limit || 50), 200);

    const out = await ddb.send(new QueryCommand({
      TableName: DDB_PRECAL_HISTORY_TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :u",
      ExpressionAttributeValues: {
        ":u": `USER#${userId}`,
      },
      ScanIndexForward: false, // más nuevas primero
      Limit: limit,
    }));

    return res.json({ ok: true, items: out.Items || [] });
  } catch (e) {
    console.error("Error listando historial:", e);
    return res.status(500).json({ ok: false, message: "Error listando historial" });
  }
});

// Eliminar un registro por pk
app.delete("/precalificaciones/historial/:pk", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "No autenticado" });

    const pk = (req.params.pk || "").toString();
    if (!pk) return res.status(400).json({ ok: false, message: "Falta pk" });

    // Best-effort: borramos. (Como no tenemos Query por PK prefix y la tabla no tiene SK,
    // asumimos pk exacta enviada desde el frontend.)
    await ddb.send(
      new DeleteCommand({
        TableName: DDB_PRECAL_HISTORY_TABLE,
        Key: { pk },
      })
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error eliminando historial:", err?.message || err);
    return res.status(500).json({ ok: false, message: "No se pudo eliminar" });
  }
});

// Limpiar TODO el historial del usuario
app.delete("/precalificaciones/historial", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ ok: false, message: "No autenticado" });

    const scanned = await ddb.send(
      new ScanCommand({
        TableName: DDB_PRECAL_HISTORY_TABLE,
        FilterExpression: "#t = :t AND #u = :u",
        ExpressionAttributeNames: { "#t": "type", "#u": "userId" },
        ExpressionAttributeValues: { ":t": "precal_hist", ":u": Number(userId) },
        Limit: 500,
      })
    );
    const items = Array.isArray(scanned?.Items) ? scanned.Items : [];

    for (const it of items) {
      if (!it?.pk) continue;
      try {
        await ddb.send(
          new DeleteCommand({
            TableName: DDB_PRECAL_HISTORY_TABLE,
            Key: { pk: it.pk },
          })
        );
      } catch (e) {
        console.warn("No pude borrar pk", it.pk, e?.message || e);
      }
    }

    return res.json({ ok: true, deleted: items.length });
  } catch (err) {
    console.error("Error limpiando historial:", err?.message || err);
    return res.status(500).json({ ok: false, message: "No se pudo limpiar" });
  }
});

app.listen(port, () =>
  console.log("Servidor backend corriendo en" +" "+ port)
);
