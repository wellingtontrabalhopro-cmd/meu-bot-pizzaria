
/**
 * --- SERVIDOR BACKEND (MODO API PRÓPRIA / WHATSAPP-WEB.JS) ---
 */

import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true })); 
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÕES ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// URL da sua API whatsapp-web.js (Ex: http://seu-vps-ip:3000/api/send-message)
// Se sua API for local, use Ngrok para gerar uma URL pública.
const CUSTOM_SEND_URL = process.env.CUSTOM_SEND_URL; 
const CUSTOM_API_KEY = process.env.CUSTOM_API_KEY; // Opcional (se vc proteje sua API)

// Inicializa IA
let ai;
if (GEMINI_API_KEY) {
    ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log("✅ IA Conectada (Google GenAI)");
} else {
    console.log("❌ IA desconectada: Falta GEMINI_API_KEY");
}

console.log(`📡 Modo: API CUSTOMIZADA (whatsapp-web.js)`);

// --- MEMÓRIA ---
let globalSystemInstruction = "VOCÊ É UM ATENDENTE DE PIZZARIA.";
let globalKnowledgeBase = "Cardápio vazio.";
const chatHistory = {}; 
let orders = [];

// --- FUNÇÃO DE ENVIO PARA SUA API ---
async function sendWhatsApp(to, body) {
    if (!CUSTOM_SEND_URL) {
        console.error("❌ Erro: CUSTOM_SEND_URL não configurada na Render.");
        return;
    }
    
    // Limpa o número (deixa apenas dígitos)
    // whatsapp-web.js geralmente aceita '551199...' ou '551199...@c.us'
    let cleanPhone = to.replace('@c.us', '').replace('whatsapp:', '').replace('+', ''); 

    try {
        // Formato padrão que a maioria das APIs Node espera
        const payload = {
            number: cleanPhone, 
            message: body,
            text: body // Enviamos os dois para garantir compatibilidade
        };

        const headers = { 'Content-Type': 'application/json' };
        if (CUSTOM_API_KEY) headers['Authorization'] = `Bearer ${CUSTOM_API_KEY}`;

        await axios.post(CUSTOM_SEND_URL, payload, { headers });
        console.log(`📤 Enviado para ${cleanPhone} via API Própria`);
    } catch (error) {
        console.error("❌ Erro ao chamar sua API:", error.message);
        // console.error("Detalhes:", error.response?.data);
    }
}

// --- ROTAS DE STATUS ---
app.get('/', (req, res) => {
    res.send(`
        <h1>Bot Online 🤖</h1>
        <p>Integrado com API Própria</p>
        <p>Gemini: ${ai ? '✅' : '❌'}</p>
        <p>Send URL: ${CUSTOM_SEND_URL ? '✅ Configurado' : '❌ Faltando'}</p>
    `);
});

// Admin Config (Frontend React chama isso)
app.post('/admin/config', (req, res) => {
    globalSystemInstruction = req.body.systemInstruction || globalSystemInstruction;
    globalKnowledgeBase = req.body.knowledgeBase || globalKnowledgeBase;
    console.log("🧠 Cérebro atualizado pelo Frontend");
    res.json({ success: true });
});

// Admin Orders
app.get('/admin/orders', (req, res) => res.json(orders));
app.post('/admin/orders/:id/status', (req, res) => {
    const order = orders.find(o => o.id === req.params.id);
    if (order) {
        order.status = req.body.status;
        if(order.customerPhone) {
             sendWhatsApp(order.customerPhone, `🔔 Status do pedido: *${req.body.status.toUpperCase()}*`)
                .catch(err => console.error("Falha notificação:", err.message));
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Pedido não encontrado" });
    }
});

// Teste de Envio
app.get('/teste-zap', async (req, res) => {
    const { celular } = req.query;
    if (!celular) return res.status(400).json({ error: "Falta celular" });
    
    let formatted = celular.replace(/\D/g, ''); 
    if (formatted.length >= 10 && !formatted.startsWith('55')) formatted = '55' + formatted;

    try {
        await sendWhatsApp(formatted, "✅ Teste de Conexão: AgentFlow -> Sua API -> WhatsApp");
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- WEBHOOK (ONDE SUA API VAI MANDAR MENSAGEM) ---
app.post('/webhook', async (req, res) => {
    // Tenta detectar o formato que sua API está enviando
    let incomingMsg = req.body.body || req.body.message || req.body.text;
    let from = req.body.from || req.body.number || req.body.phone;

    // Se vier objeto complexo (algumas libs mandam obj inteiro)
    if (typeof incomingMsg === 'object') incomingMsg = JSON.stringify(incomingMsg);

    if (!incomingMsg || !from) {
        console.log("⚠️ Webhook recebido sem 'from' ou 'body'. Payload:", req.body);
        return res.status(400).send("Formato inválido");
    }

    // Ignora mensagens de status ou grupos se necessário
    if (from.includes('@g.us')) return res.send("Ignorando Grupo");

    console.log(`📩 De ${from}: ${incomingMsg}`);

    // Cria sessão se não existir
    if (!chatHistory[from]) chatHistory[from] = [];
    chatHistory[from].push({ role: 'user', parts: [{ text: incomingMsg }] });

    try {
        if (!ai) throw new Error("IA offline");

        const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: chatHistory[from],
            config: { systemInstruction: globalSystemInstruction + "\n\n" + globalKnowledgeBase }
        });

        let responseText = result.text;
        
        // Processa Pedidos (Lógica de JSON Oculto)
        const orderRegex = /!!!ORDER_START!!!([\s\S]*?)!!!ORDER_END!!!/;
        const match = responseText.match(orderRegex);
        if (match && match[1]) {
            try {
                const orderData = JSON.parse(match[1]);
                const newOrder = {
                    id: `APP-${Date.now().toString().slice(-4)}`,
                    customerName: orderData.nome_cliente || "Cliente",
                    customerPhone: from,
                    address: orderData.endereco_completo,
                    items: orderData.itens || [],
                    total: orderData.total_numerico || 0,
                    paymentMethod: orderData.forma_pagamento,
                    changeNeeded: orderData.troco_para,
                    status: 'pending',
                    timestamp: Date.now()
                };
                orders.unshift(newOrder);
                responseText = responseText.replace(orderRegex, '').trim() + "\n\n✅ *Pedido Recebido e enviado para a Cozinha!*";
            } catch(e) { console.error("Erro ao ler JSON do pedido:", e); }
        }

        chatHistory[from].push({ role: 'model', parts: [{ text: responseText }] });
        
        // Responde usando sua API
        await sendWhatsApp(from, responseText);

    } catch (error) {
        console.error("Erro no fluxo da IA:", error);
    }

    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
