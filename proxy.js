// proxy.js (AWS DynamoDB cache 1 mes + Microsoft Graph Mail)
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const { enviarCorreoGraph } = require("./enviarCorreoGraph");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
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

// ============================
// USUARIOS
// ============================
const users = [
  {
    id: 1,
    username: process.env.ADMIN_USER,
    passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10),
    role: "admin",
  },
  {
    id: 2,
    username: process.env.COMERCIAL_USER,
    passwordHash: bcrypt.hashSync(process.env.COMERCIAL_PASSWORD, 10),
    role: "analyst",
  },
  {
    id: 3,
    username: process.env.OPERATIVO_USER,
    passwordHash: bcrypt.hashSync(process.env.OPERATIVO_PASSWORD, 10),
    role: "sales",
  },
  {
    id: 4,
    username: process.env.GERENTE_USER,
    passwordHash: bcrypt.hashSync(process.env.GERENTE_PASSWORD, 10),
    role: "manager",
  }
];

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
// ENVIAR CORREO (MICROSOFT GRAPH) - DESTINATARIOS FIJOS
// ============================
app.post("/enviarCorreo", authenticateJWT, async (req, res) => {
  try {
    const { subject, html, attachments } = req.body;

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
      attachments: safeAttachments,
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
// GUARDAR PRECALIFICACIÓN EN EXCEL
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
      concesionario
    } = req.body || {};

    if (!cedulaDeudor) {
      return res.status(400).json({
        ok: false,
        message: "Falta cedulaDeudor"
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
      String(concesionario ?? "")
    ]);

    return res.json({
      ok: true,
      message: "Precalificación guardada en Excel"
    });

  } catch (err) {
    const status = err?.response?.status || 500;
    const details = err?.response?.data || err?.message || String(err);

    console.error("❌ Error Excel OneDrive:", details);

    return res.status(status).json({
      ok: false,
      message: "No se pudo escribir en el Excel",
      details
    });
  }
});

app.listen(port, () =>
  console.log("Servidor backend corriendo en http://localhost:3000")
);
