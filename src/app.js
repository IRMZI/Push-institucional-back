const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { config } = require("./config");

function createApp() {
    const app = express();

    // Atrás do proxy do Coolify/Traefik: req.ip = IP real do visitante (rate limit e CAPI dependem disso)
    app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 1);
    app.disable("x-powered-by");

    app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

    const allowed = new Set(["http://localhost:5173", "http://localhost:4173", ...config.frontendUrls]);
    app.use(
        cors({
            // Sem origin (curl, healthcheck) passa; origem desconhecida é bloqueada sem erro no log
            origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
            methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allowedHeaders: ["Content-Type", "Authorization", "X-Filename", "X-Alt"],
            exposedHeaders: ["Content-Disposition"],
            maxAge: 86400,
        })
    );

    // Upload de mídia precisa do corpo binário: registrado antes do parser JSON
    app.use("/api/cms", require("./routes/cms"));
    app.use(express.json({ limit: "64kb" }));
    // navigator.sendBeacon envia text/plain (evita preflight de CORS)
    app.use(express.text({ type: "text/plain", limit: "32kb" }));

    app.get("/api/health", async (_req, res) => {
        try {
            const sql = require("./db");
            await sql`SELECT 1`;
            res.json({ status: "ok", db: "ok", timestamp: new Date().toISOString() });
        } catch {
            res.status(503).json({ status: "degraded", db: "erro", timestamp: new Date().toISOString() });
        }
    });

    app.use("/api/auth", require("./routes/auth"));
    app.use("/api/sessions", require("./routes/sessions"));
    app.use("/api/conversoes", require("./routes/conversoes"));
    app.use("/api/leads", require("./routes/leads"));
    app.use("/api/dashboard", require("./routes/dashboard"));
    app.use("/api/tags", require("./routes/tags"));
    app.use("/api/campaigns", require("./routes/campaigns"));
    app.use("/api/users", require("./routes/users"));
    app.use("/api/settings", require("./routes/settings"));
    app.use("/api", require("./routes/public"));

    app.use("/api", (_req, res) => res.status(404).json({ error: "Rota não encontrada." }));

    // JSON inválido e erros não tratados
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
        if (err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON inválido." });
        if (err.type === "entity.too.large") return res.status(413).json({ error: "Payload muito grande." });
        console.error("Erro não tratado:", err);
        res.status(500).json({ error: "Erro interno." });
    });

    return app;
}

module.exports = { createApp };
