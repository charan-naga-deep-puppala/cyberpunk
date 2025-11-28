require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const enemyRegistry = new Map();

// --- WORLD DATA ---
const CITIES = {
    "Neo-Kowloon": "Classic Cyberpunk. Rain, neon, noodle stands.",
    "The Scrapyard": "Industrial hellscape. Burning metal, robot graveyard.",
    "Solaris District": "Psychological horror. Hallucinations.",
    "Magrathea Heights": "Ultra-luxury factory. Artificial sunsets.",
    "Trantor Deep": "City-planet covered in metal. Endless bureaucracy.",
    "The Zone": "Anomaly area. Physics glitch.",
    "Ubik Reality": "Retro-futuristic suburb that constantly decays.",
    "Gargantus Space": "Surreal, vacuum of space, philosophical constructs, absurd machinery."
};

const SYSTEM_INSTRUCTION = `
You are the Game Master of a specialized Text RPG.

### OUTPUT FORMAT (SCREENPLAY STYLE):
- **DO NOT** write block paragraphs.
- Use: **LOCATION:**, **ACTION:**, **DIALOGUE:**.
- Keep length consistent: roughly 80-120 words per turn. Not too short, not a novel.
- Use *sound effects* (e.g. *Hiss*, *Thud*).

### PACING & LENGTH:
- Current Turn: [TURN] of [TOTAL_LENGTH].
- **0-25%:** Introduction. Establish the world.
- **25-75%:** Rising Action. Challenges and Clues.
- **75-90%:** Climax. High stakes.
- **90-100%:** Conclusion. Force the ending.

### SPECIAL STORIES (CURATED):
- If Archetype is **"GARGANTUS"**: 
  - **Tone:** Stanislaw Lem style. Satirical, philosophical, bureaucratic absurdity, dry humor.
  - **Plot:** A journey to the anomaly 'Gargantus'. 
  - **Ending:** Must end with a paradox or the realization it was a simulation/time-loop.

### STANDARD MECHANICS:
1. **COMBAT:** Headshots/Core hits are FATAL. Player death = "isGameOver": true.
2. **CHARACTERS:** Add new NPCs to "newCharacters".
3. **LANGUAGE:** Respond ONLY in [LANGUAGE].

JSON FORMAT:
{
  "narrative": "Screenplay formatted text.",
  "visual_prompt": "Visual description.",
  "enemyName": "String or null",
  "inCombat": boolean,
  "enemyStats": { "name": "String", "hp": number, "maxHp": number } OR null,
  "newCharacters": [ { "name": "Name", "description": "Visual details..." } ] OR null,
  "choices": ["Opt1", "Opt2"], 
  "caseSolved": boolean,
  "stats": { "hp": 100, "credits": 50 },
  "inventoryUpdates": { "add": [], "remove": [] } OR null,
  "isGameOver": boolean
}
`;

async function generateImagenImage(prompt) {
    try {
        const response = await ai.models.generateImages({
            model: 'imagen-3.0-generate-001', 
            prompt: "Sci-fi concept art, cinematic lighting, detailed. " + prompt,
            config: { numberOfImages: 1, aspectRatio: "16:9" },
        });
        const imgBytes = response.generatedImages[0].image.imageBytes;
        return `data:image/png;base64,${imgBytes}`;
    } catch (error) {
        const seed = Math.floor(Math.random() * 9999);
        return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${seed}`;
    }
}

app.post('/api/turn', async (req, res) => {
    try {
        let { history, userAction, currentStats, playerProfile, currentCity, enemyStats, language, inventory, turnCount, maxTurns } = req.body;
        
        // Init logic
        if (!turnCount) turnCount = 0;
        if (!maxTurns) maxTurns = 40; // Default medium
        turnCount++;

        // --- ORIGIN STORY LOGIC ---
        if (history.length === 0) {
            turnCount = 1;
            if (playerProfile.archetype === "RAVEN") {
                currentCity = "Neo-Kowloon";
                userAction = "I am Raven. Precinct Office. Reviewing the murder files. I need a smoke.";
            } else if (playerProfile.archetype === "I-6") {
                currentCity = "The Scrapyard";
                userAction = "I am Unit I-6. Systems online. Conveyor belt moving to furnace. Must escape.";
            } else if (playerProfile.archetype === "GARGANTUS") {
                currentCity = "Gargantus Space";
                userAction = "I am the Pilot. Entering the orbit of Gargantus. The ship's computer is arguing with me about the definition of 'arrival'.";
            } else {
                currentCity = "Neo-Kowloon";
                userAction = `I am ${playerProfile.name}, a ${playerProfile.class}. ${playerProfile.backstory}`;
            }
        }

        const cityVibe = CITIES[currentCity] || "Sci-Fi Location";
        
        let fullPrompt = `SYSTEM: ${SYSTEM_INSTRUCTION}\n`;
        fullPrompt += `LANGUAGE: ${language}\n`;
        fullPrompt += `PACING: Turn ${turnCount} of ${maxTurns}.\n`;
        fullPrompt += `PLAYER: ${playerProfile?.name} (${playerProfile?.class})\n`;
        fullPrompt += `LOC: ${currentCity} (${cityVibe})\n`;
        fullPrompt += `STATUS: HP=${currentStats.hp}\n`;
        fullPrompt += `INVENTORY: ${JSON.stringify(inventory)}\n`;
        if (enemyStats) fullPrompt += `ENEMY: ${enemyStats.name} (HP: ${enemyStats.hp})\n`;
        
        fullPrompt += `HISTORY:\n`;
        // Provide last 10 turns for context
        history.slice(-10).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
        fullPrompt += `PLAYER ACTION: ${userAction}\nGM (JSON):`;

        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { responseMimeType: 'application/json' }
        });

        const gameData = JSON.parse(textResponse.text);

        // Force Ending Logic
        if (turnCount >= maxTurns && !gameData.isGameOver) {
            gameData.narrative += "\n\n[SYSTEM]: SIMULATION LIMIT REACHED. NARRATIVE CONCLUDED.";
            gameData.isGameOver = true;
        }

        // Image Generation
        let finalImageUrl = "";
        const isFirstTurn = history.length === 0;

        if (isFirstTurn) {
            finalImageUrl = await generateImagenImage(`Portrait of ${playerProfile.name}, ${playerProfile.style}, inside ${currentCity}`);
        } else if (gameData.enemyName) {
            const slug = gameData.enemyName.trim().toLowerCase().replace(/\s+/g, '-');
            if (enemyRegistry.has(slug)) {
                finalImageUrl = enemyRegistry.get(slug);
            } else {
                finalImageUrl = await generateImagenImage("Character portrait of " + gameData.visual_prompt);
                enemyRegistry.set(slug, finalImageUrl);
            }
        } else if (gameData.inCombat) {
             finalImageUrl = await generateImagenImage(`Action shot, combat, ${gameData.visual_prompt}`);
        } else {
            finalImageUrl = await generateImagenImage(`Cinematic scene in ${currentCity}: ${gameData.visual_prompt}`);
        }

        gameData.currentCity = currentCity; 
        gameData.imageUrl = finalImageUrl;
        gameData.turnCount = turnCount;
        
        res.json(gameData);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ narrative: "System Failure.", choices: ["Retry"], stats: req.body.currentStats });
    }
});

// --- UPDATED SUMMARY ENDPOINT ---
app.post('/api/summary', async (req, res) => {
    try {
        const { history, language } = req.body;
        // Limit history to prevent token overflow, but keep enough for context
        const recentHistory = history.slice(-20); 
        
        let prompt = `You are a Log Bot. Summarize the story so far in ${language}.\n`;
        prompt += `Format sections clearly:\n1. PRIMARY MISSION\n2. RECENT EVENTS\n3. CURRENT STATUS\n\nLOG DATA:\n`;
        recentHistory.forEach(t => prompt += `${t.role}: ${t.content}\n`);
        
        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        res.json({ summary: textResponse.text });
    } catch (error) {
        console.error(error);
        res.status(500).json({ summary: "ARCHIVE CORRUPTED. UNABLE TO GENERATE SUMMARY." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(port, () => console.log(`Server running on port ${port}`));
