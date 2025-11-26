/**
 * --- SERVIDOR BACKEND (PARA RENDER.COM) ---
 * Salve este arquivo como 'index.js' no seu repositório.
 */

import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Habilita CORS para que seu Frontend React consiga falar com este Backend
app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const Z_API_INSTANCE = process.env.Z_API_INSTANCE; 
const Z_API_TOKEN = process.env.Z_API_TOKEN;       
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- ESTADO DO SISTEMA (MEMÓRIA) ---
// Em um app real, isso ficaria num banco de dados.

// Configuração Padrão (será sobrescrita pelo botão "Sincronizar" do Frontend)
let globalSystemInstruction = `
VOCÊ É UM ATENDENTE DE PIZZARIA.
Seu objetivo é anotar pedidos, tirar dúvidas e ser cortês.
Sempre verifique se o produto está disponível no cardápio abaixo.
Mantenha as respostas curtas, ideais para WhatsApp.
`;

let globalKnowledgeBase = `
=== CARDÁPIO ===
(Aguardando sincronização do App...)
`;

// Histórico de Conversas
const chatHistory = {};

// Pedidos Realizados
let orders = [];

// --- ROTAS DE ADMINISTRAÇÃO (Conectam com o React App) ---

// 1. Rota para o React enviar a nova configuração
app.post('/admin/config', (req, res) => {
    const { systemInstruction, knowledgeBase } = req.body;
    
    if (systemInstruction) globalSystemInstruction = systemInstruction;
    if (knowledgeBase) globalKnowledgeBase = knowledgeBase;

    console.log("✅ Configuração atualizada pelo Frontend!");
    res.json({ success: true, message: "Cérebro atualizado com sucesso." });
});

// 2. Rota para o React buscar os pedidos (Polling)
app.get('/admin/orders', (req, res) => {
    res.json(orders);
});

// 3. Rota para atualizar status do pedido (Cozinha)
app.post('/admin/orders/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    const orderIndex = orders.findIndex(o => o.id === id);
    if (orderIndex !== -1) {
        orders[orderIndex].status = status;
        // Opcional: Avisar o cliente no WhatsApp que o status mudou
        // sendWhatsAppMessage(orders[orderIndex].customerPhone, `Seu pedido mudou para: ${status}`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Order not found" });
    }
});


// --- ROTA HEALTH CHECK ---
app.get('/', (req, res) => {
    res.status(200).send('Bot Pizza Online 🍕');
});

// --- ROTA WEBHOOK (Z-API) ---
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    // Ignora status de entrega ou mensagens enviadas por mim
    if (!data || !data.phone || data.fromMe) {
        return res.status(200).send('Ignored');
    }

    const userPhone = data.phone;
    // Tenta pegar o texto de diferentes formatos
    const userText = data.text?.message || data.text || data.caption; 

    if (!userText) {
        return res.status(200).send('No text content');
    }

    console.log(`📩 Msg de ${userPhone}: ${userText}`);

    // Inicializa histórico
    if (!chatHistory[userPhone]) {
        chatHistory[userPhone] = [];
    }

    // Adiciona msg do usuário
    chatHistory[userPhone].push({ role: 'user', parts: [{ text: userText }] });

    // Gera resposta com Gemini
    const model = 'gemini-2.5-flash';
    const result = await ai.models.generateContent({
        model: model,
        contents: chatHistory[userPhone],
        config: {
            systemInstruction: globalSystemInstruction + "\n\n" + globalKnowledgeBase
        }
    });

    let botResponse = result.text;
    
    // --- LÓGICA DE DETECÇÃO DE PEDIDO ---
    // Verifica se o Gemini gerou um bloco de pedido JSON
    const orderBlockRegex = /!!!ORDER_START!!!([\s\S]*?)!!!ORDER_END!!!/;
    const match = botResponse.match(orderBlockRegex);

    if (match && match[1]) {
        try {
            const jsonStr = match[1].trim();
            const orderData = JSON.parse(jsonStr);
            
            // Adiciona ID e Timestamp e salva na memória
            const newOrder = {
                id: `ZAP-${Date.now().toString().slice(-4)}`,
                customerName: orderData.nome_cliente || userPhone,
                customerPhone: userPhone,
                address: orderData.endereco_completo || 'Retirada',
                items: orderData.items || orderData.itens || [],
                total: orderData.total_numerico || 0,
                paymentMethod: orderData.forma_pagamento || 'Dinheiro',
                changeNeeded: orderData.troco_para,
                status: 'pending',
                timestamp: Date.now()
            };

            orders.unshift(newOrder); // Adiciona no início da lista
            console.log("🍕 NOVO PEDIDO RECEBIDO VIA WHATSAPP:", newOrder.id);

            // Remove o bloco JSON da resposta antes de enviar pro usuário
            botResponse = botResponse.replace(orderBlockRegex, '').trim();
            
            // Adiciona confirmação se não tiver
            if (!botResponse.includes("pedido confirmado")) {
                botResponse += "\n\n✅ *Seu pedido foi confirmado e enviado para a cozinha!*";
            }

        } catch (e) {
            console.error("Erro ao processar JSON do pedido:", e);
        }
    }

    // Salva resposta do bot no histórico (limpa)
    chatHistory[userPhone].push({ role: 'model', parts: [{ text: botResponse }] });

    // Envia para o WhatsApp
    await sendWhatsAppMessage(userPhone, botResponse);

    res.status(200).send('OK');

  } catch (error) {
    console.error('Erro no processamento:', error);
    res.status(200).send('Erro processado'); 
  }
});

async function sendWhatsAppMessage(phone, message) {
    if (!Z_API_INSTANCE || !Z_API_TOKEN) return;
    
    const url = `https://api.z-api.io/instances/${Z_API_INSTANCE}/token/${Z_API_TOKEN}/send-text`;
    
    try {
        await axios.post(url, { phone, message });
    } catch (err) {
        console.error('Z-API Error:', err.message);
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
