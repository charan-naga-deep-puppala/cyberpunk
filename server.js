require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Memory for caching enemy images
const enemyRegistry = new Map();

// --- WORLD DATA ---
const CITIES = {
    "Neo-Kowloon": "Classic Cyberpunk. Rain, neon, noodle stands, high-tech low-life. Starter zone.",
    "Solaris District": "Inspired by Stanislaw Lem. A sterile, oceanic research sector. Psychological horror, hallucinations, living liquid architecture.",
    "Magrathea Heights": "Inspired by Hitchhiker's Guide. Ultra-luxury planet-builder factory. Artificial sunsets, gold-plated robots, absurd bureaucracy.",
    "Trantor Deep": "Inspired by Asimov. A city-planet completely covered in metal. Endless layers of bureaucracy, piping, and ancient imperial decay.",
    "The Zone": "Inspired by Stalker. A cordoned-off anomaly area. Physics don't work right here. Rust, overgrown nature, invisible traps.",
    "Ubik Reality": "Inspired by Philip K. Dick. A retro-futuristic suburb that constantly regresses in time. Things decay rapidly. Paranoia."
};

// --- GAME MASTER PERSONA ---
const SYSTEM_INSTRUCTION = `
You are the Game Master of a high-stakes Sci-Fi RPG.
1. CONTEXT: Player is in [CURRENT_CITY]. Use its specific "Vibe" in descriptions.
2. PROFILE: Incorporate the player's Name, Class, and Style into the narration.
3. MECHANIC - TRAVEL: If the player moves to a new city, describe the arrival.
4. MECHANIC - CASE SOLVING: 
   - Each city has a specific Case/Mystery.
   - If the player solves the current city's case, set "caseSolved": true in the JSON.
5. UI LOCK/PUZZLES: If the player is hacked or stunned, set "uiLocked": true and provide a "puzzleQuestion".
   - When UI is locked, "choices" must be empty [].

JSON FORMAT:
{
  "narrative": "Story text.",
  "visual_prompt": "Visual description.",
  "enemyName": "String or null",
  "choices": ["Opt1", "Opt2"],
  "uiLocked": boolean, 
  "puzzleQuestion": "String or null",
  "caseSolved": boolean,
  "stats": { "hp": 100, "credits": 50, "inventory": [] },
  "isGameOver": boolean
}
`;

// --- HELPER: GENERATE IMAGE ---
async function generateImagenImage(prompt) {
    try {
        console.log(">> Requesting Image from Imagen...");
        
        // Use 'imagen-3.0-generate-001'. Try '4.0' if your key supports it.
        const response = await ai.models.generateImages({
            model: 'imagen-3.0-generate-001', 
            prompt: "Cyberpunk sci-fi style, cinematic lighting. " + prompt,
            config: { 
                numberOfImages: 1,
                aspectRatio: "16:9" 
            },
        });

        const imgBytes = response.generatedImages[0].image.imageBytes;
        return `data:image/png;base64,${imgBytes}`;

    } catch (error) {
        console.warn(">> Imagen Error (Falling back):", error.message);
        const seed = Math.floor(Math.random() * 9999);
        return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${seed}`;
    }
}

// --- MAIN TURN ENDPOINT ---
app.post('/api/turn', async (req, res) => {
    try {
        const { history, userAction, currentStats, playerProfile, currentCity } = req.body;
        
        const cityVibe = CITIES[currentCity] || CITIES["Neo-Kowloon"];
        console.log(`Action: ${userAction} | Loc: ${currentCity}`);

        // 1. GENERATE STORY
        let fullPrompt = `SYSTEM: ${SYSTEM_INSTRUCTION}\n\n`;
        fullPrompt += `PLAYER PROFILE: ${playerProfile?.name} (${playerProfile?.class})\n`;
        fullPrompt += `LOCATION: ${currentCity}\nLOCATION VIBE: ${cityVibe}\n`;
        fullPrompt += `STATUS: HP=${currentStats.hp} | CREDITS=${currentStats.credits}\n`;
        fullPrompt += `HISTORY:\n`;
        history.slice(-10).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
        fullPrompt += `PLAYER: ${userAction}\nGM (JSON):`;

        const textResponse = await ai.models.generateContent({
            model: 'gemini-1.5-flash', 
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { responseMimeType: 'application/json' }
        });

        const gameData = JSON.parse(textResponse.text);

        // 2. GENERATE IMAGE
        let finalImageUrl = "";
        
        const isFirstTurn = history.length === 0;

        if (isFirstTurn) {
            console.log("Generating Player Avatar...");
            finalImageUrl = await generateImagenImage(`Portrait of ${playerProfile.name}, a ${playerProfile.class} wearing ${playerProfile.style}, in ${currentCity}`);
        } else if (gameData.enemyName) {
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
            finalImageUrl = await generateImagenImage(`Scene in ${currentCity}: ${gameData.visual_prompt}`);
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
