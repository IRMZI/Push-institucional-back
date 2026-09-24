const rateLimit = require("express-rate-limit");

const make = (windowMs, limit, error) =>
    rateLimit({ windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false, message: { error } });

module.exports = {
    // Tracking: generoso (um visitante gera vários lotes por visita)
    trackingLimiter: make(60 * 1000, 120, "Muitas requisições."),
    conversionLimiter: make(60 * 1000, 30, "Muitas requisições."),
    // Formulário: poucas tentativas por IP
    leadLimiter: make(10 * 60 * 1000, 6, "Muitos envios em sequência. Tente novamente em alguns minutos."),
    loginLimiter: rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 8,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: { error: "Muitas tentativas de login. Tente novamente em 15 minutos." },
    }),
};
