require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Memory for caching enemy images
const enemyRegistry = new Map();

// --- GAME MASTER PERSONA ---
const SYSTEM_INSTRUCTION = `
You are the witty, cynical Game Master of a "Cyberpunk Noir" RPG.
1. ENEMY: If a named enemy appears, output "enemyName".
2. UI LOCK: If the player is hacked, set "uiLocked": true and provide a "puzzleQuestion".
3. OUTPUT: JSON only.
4. MEMORY: Remember past interactions.

JSON FORMAT:
{
  "narrative": "Story text (max 4 sentences).",
  "visual_prompt": "Visual description.",
  "enemyName": "String or null",
  "choices": ["Opt1", "Opt2"],
  "uiLocked": boolean, 
  "puzzleQuestion": "String or null",
  "stats": { "hp": 100, "credits": 50, "inventory": [] },
  "isGameOver": boolean
}
`;

// --- HELPER: GENERATE IMAGE ---
async function generateImagenImage(prompt) {
    try {
        console.log(">> Requesting Image from Imagen...");
        
        // Use 'imagen-3.0-generate-001' (Standard)
        const response = await ai.models.generateImages({
            model: 'imagen-4.0-generate-001', 
            prompt: "Cyberpunk noir style, cinematic lighting, high contrast. " + prompt,
            config: { 
                numberOfImages: 1,
                aspectRatio: "16:9" 
            },
        });

        // Convert raw bytes to Base64 for the browser
        const imgBytes = response.generatedImages[0].image.imageBytes;
        return `data:image/png;base64,${imgBytes}`;

    } catch (error) {
        console.warn(">> Imagen Error (Falling back):", error.message);
        // Fallback to Pollinations if Imagen fails or is not enabled
        const seed = Math.floor(Math.random() * 9999);
        return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${seed}`;
    }
}

// --- MAIN TURN ENDPOINT ---
app.post('/api/turn', async (req, res) => {
    try {
        const { history, userAction, currentStats } = req.body;
        console.log(`Action: ${userAction}`);

        // 1. GENERATE STORY
        let fullPrompt = `SYSTEM: ${SYSTEM_INSTRUCTION}\n\n`;
        fullPrompt += `STATUS: HP=${currentStats.hp} | CREDITS=${currentStats.credits}\n`;
        fullPrompt += `HISTORY:\n`;
        history.slice(-10).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
        fullPrompt += `PLAYER: ${userAction}\nGM (JSON):`;

        // Use 'gemini-1.5-flash' (Most reliable) or 'gemini-2.0-flash' (Newer)
        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { 
                responseMimeType: 'application/json',
                temperature: 0.85
            }
        });

        // FIX: Access .text() directly (or .text property) depending on SDK version
        // The new SDK usually exposes it as a getter property .text
        const jsonText = textResponse.text; 
        const gameData = JSON.parse(jsonText);

        // 2. GENERATE IMAGE
        let finalImageUrl = "";
        
        if (gameData.enemyName) {
            const slug = gameData.enemyName.trim().toLowerCase().replace(/\s+/g, '-');
            if (enemyRegistry.has(slug)) {
                console.log(`Using cached image for ${gameData.enemyName}`);
                finalImageUrl = enemyRegistry.get(slug);
            } else {
                console.log(`Generating NEW image for ${gameData.enemyName}`);
                finalImageUrl = await generateImagenImage("Character portrait of " + gameData.visual_prompt);
                enemyRegistry.set(slug, finalImageUrl);
            }
        } else {
            finalImageUrl = await generateImagenImage("Cinematic scene: " + gameData.visual_prompt);
        }

        gameData.imageUrl = finalImageUrl;
        res.json(gameData);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ 
            narrative: "System Failure. The neural link has been severed.", 
            choices: ["Reboot System"], 
            stats: req.body.currentStats 
        });
    }
});

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
    console.log(`GenAI Server running on http://localhost:${port}`);
});