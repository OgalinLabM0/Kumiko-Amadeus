/**
 * electron-rag.cjs
 * 
 * Electron Main Process RAG Module
 * Handles: SQLite vector storage, bge-m3 ONNX embedding, HNSW ANN index, hybrid search (HNSW + BM25 + RRF)
 * 
 * Architecture:
 *   SQLite  → Persistent storage (vectors, text, metadata)
 *   HNSW    → In-memory ANN index for O(log n) approximate nearest neighbor search
 *   BM25    → Keyword-based scoring computed on-the-fly
 *   RRF     → Reciprocal Rank Fusion combining HNSW + BM25 results
 * 
 * All RAG operations run in the main process. Renderer communicates via IPC.
 */

const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');
const Database = require('better-sqlite3');
const { Worker } = require('worker_threads');
const { pathToFileURL } = require('url');

// --- LORE DATA ---
// NOTE ON "ENCRYPTION":
// `lore.enc` is OBFUSCATED, not cryptographically secret. The key below ships inside the
// binary by design — anyone with the .exe / source can recover it in seconds (grep or
// asar extract). The goal is purely to discourage casual tampering and keep the lore
// file out of plain text diffs. If you ever need lore to be actually private, fetch it
// from a server at runtime or inject the key at build-time via an env var — do not try
// to "hide" the key inside source.
let loreChunks = [];
try {
    const lorePath = path.join(__dirname, 'assets', 'lore.enc');
    const crypto = require('crypto');
    if (fs.existsSync(lorePath)) {
        const LORE_OBFUSCATION_KEY = 'kumiko-amadeus-lore-2026-hibike';
        const encrypted = fs.readFileSync(lorePath, 'utf8');
        const [ivHex, encryptedHex] = encrypted.split(':');
        const key = crypto.createHash('sha256').update(LORE_OBFUSCATION_KEY).digest();
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        loreChunks = JSON.parse(decrypted);
        console.log(`[RAG] Loaded ${loreChunks.length} lore chunks from obfuscated file`);
    }
} catch (e) {
    console.warn('[RAG] Could not load lore.enc, lore data will be empty:', e.message);
}

// --- CONFIG ---
const DB_NAME = 'rag_vectors.db';
const MODEL_DIR_NAME = 'bge-m3-onnx';
const EMBEDDING_DIM = 1024; // bge-m3 output dimension
const HNSW_M = 16;          // HNSW: max number of connections per node (quality vs memory tradeoff)
const HNSW_EF_CONSTRUCTION = 200; // HNSW: size of dynamic candidate list during construction
const HNSW_EF_SEARCH = 100;       // HNSW: size of dynamic candidate list during search (higher = more accurate)
const RAG_TIER_CORE = 'core';
const RAG_TIER_EPISODIC = 'episodic';
const RAG_TIER_BACKGROUND = 'background';
const EPISODIC_MERGE_WINDOW_MS = 30 * 60 * 1000;
const EPISODIC_MERGE_MAX_CANDIDATES = 8;
const EPISODIC_MERGE_MAX_SEGMENTS = 4;
const EPISODIC_MERGE_MIN_VECTOR_SIMILARITY = 0.58;
const EPISODIC_MERGE_MIN_TOKEN_OVERLAP = 0.16;
const REBUILD_PROGRESS_THROTTLE_MS = 120;

// --- STATE ---
let db = null;
let ragWorker = null;
let isModelLoaded = false;
let modelLoadError = null;
let modelLoadPromise = null;
let activeModelBackend = 'none';
let mainProcessOrt = null;
let mainProcessSession = null;
let mainProcessTokenizer = null;

let messageIdCounter = 0;
const workerCallbacks = new Map();
let ragWorkerModelLoaded = false;
let ragWorkerLoadPromise = null;
let rebuildCoreModulePromise = null;
let activeRebuildJob = null;
let rebuildJobCounter = 0;

// HNSW State
const createHnswState = () => ({
    index: null,
    idMap: new Map(),       // HNSW internal label → SQLite row id
    reverseMap: new Map(),  // SQLite row id → HNSW internal label
    nextLabel: 0,
});

let hnswStates = {
    [RAG_TIER_CORE]: createHnswState(),
    [RAG_TIER_EPISODIC]: createHnswState(),
    [RAG_TIER_BACKGROUND]: createHnswState(),
};

// --- PATHS ---
function getModelDir() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'models', MODEL_DIR_NAME);
    }
    return path.join(__dirname, 'models', MODEL_DIR_NAME);
}

function getDbPath() {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, DB_NAME);
}

async function loadRebuildCoreModule() {
    if (!rebuildCoreModulePromise) {
        rebuildCoreModulePromise = import(
            pathToFileURL(path.join(__dirname, 'services', 'ragRebuildCore.js')).href
        ).catch((error) => {
            rebuildCoreModulePromise = null;
            throw error;
        });
    }
    return rebuildCoreModulePromise;
}

function stripWindowsLongPathPrefix(filePath) {
    if (typeof filePath === 'string' && filePath.startsWith('\\\\?\\')) {
        return filePath.slice(4);
    }
    return filePath;
}

function normalizeFsPath(filePath) {
    return stripWindowsLongPathPrefix(path.resolve(String(filePath || '')));
}

function prependProcessPath(entryPath) {
    const normalizedEntryPath = normalizeFsPath(entryPath);
    if (!normalizedEntryPath || !fs.existsSync(normalizedEntryPath)) return;

    const delimiter = path.delimiter;
    const currentPath = process.env.PATH || '';
    const currentEntries = currentPath.split(delimiter).filter(Boolean).map(e => normalizeFsPath(e));
    if (currentEntries.includes(normalizedEntryPath)) return;

    process.env.PATH = `${normalizedEntryPath}${delimiter}${currentPath}`;
}

function getOnnxRuntimeWebSourcePath() {
    return normalizeFsPath(path.dirname(require.resolve('onnxruntime-web/package.json')));
}

function getStagedNativeModulesRoot() {
    return normalizeFsPath(
        path.join(app.getPath('userData'), 'native-modules')
    );
}

function readPackageVersion(packageDir) {
    const normalizedDir = normalizeFsPath(packageDir);
    const packageJsonPath = path.join(normalizedDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version || null;
    } catch {
        return null;
    }
}

function ensureStagedPackage(sourceDir, targetDir, requiredRelativePaths = []) {
    const normalizedSourceDir = normalizeFsPath(sourceDir);
    const normalizedTargetDir = normalizeFsPath(targetDir);
    if (!fs.existsSync(normalizedSourceDir)) {
        throw new Error(`Native package source not found: ${normalizedSourceDir}`);
    }

    const sourceVersion = readPackageVersion(normalizedSourceDir);
    const targetVersion = readPackageVersion(normalizedTargetDir);
    const hasRequiredFiles = requiredRelativePaths.every(relativePath => (
        fs.existsSync(path.join(normalizedTargetDir, relativePath))
    ));

    if (sourceVersion && targetVersion === sourceVersion && hasRequiredFiles) {
        return normalizedTargetDir;
    }

    fs.rmSync(normalizedTargetDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(normalizedTargetDir), { recursive: true });
    fs.cpSync(normalizedSourceDir, normalizedTargetDir, { recursive: true, force: true });
    return normalizedTargetDir;
}

function ensureOnnxRuntimeWebDistPath() {
    if (app.isPackaged) {
        return normalizeFsPath(path.join(process.resourcesPath, 'onnxruntime-web-dist'));
    }

    const sourcePackageDir = getOnnxRuntimeWebSourcePath();
    return normalizeFsPath(path.join(sourcePackageDir, 'dist'));
}

function requireOnnxRuntimeNode() {
    const ort = require('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = ensureOnnxRuntimeWebDistPath() + path.sep;
    return ort;
}

function rejectAllWorkerCallbacks(error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error || 'RAG worker failed.'));
    workerCallbacks.forEach(({ reject }) => reject(normalizedError));
    workerCallbacks.clear();
}

function ensureRagWorker() {
    if (ragWorker) {
        return ragWorker;
    }

    ragWorker = new Worker(path.join(__dirname, 'rag-worker.cjs'));
    ragWorker.on('message', (message = {}) => {
        const callback = workerCallbacks.get(message.id);
        if (!callback) return;
        workerCallbacks.delete(message.id);

        if (message.success === false) {
            callback.reject(new Error(message.error || `[RAG Worker] ${message.action || 'unknown'} failed.`));
            return;
        }

        callback.resolve(message);
    });
    ragWorker.on('error', (error) => {
        console.error('[RAG Worker] Worker error:', error);
        ragWorker = null;
        ragWorkerModelLoaded = false;
        ragWorkerLoadPromise = null;
        rejectAllWorkerCallbacks(error);
    });
    ragWorker.on('exit', (code) => {
        const exitedWorker = ragWorker;
        ragWorker = null;
        ragWorkerModelLoaded = false;
        ragWorkerLoadPromise = null;
        if (code !== 0 && workerCallbacks.size > 0) {
            rejectAllWorkerCallbacks(new Error(`[RAG Worker] Worker exited with code ${code}.`));
        } else {
            workerCallbacks.clear();
        }
        if (code !== 0 && exitedWorker) {
            console.warn(`[RAG Worker] Worker exited unexpectedly with code ${code}.`);
        }
    });

    return ragWorker;
}

function callRagWorker(action, payload = {}) {
    const worker = ensureRagWorker();
    return new Promise((resolve, reject) => {
        const id = `rag-worker-${Date.now()}-${++messageIdCounter}`;
        workerCallbacks.set(id, { resolve, reject });
        try {
            worker.postMessage({ id, action, payload });
        } catch (error) {
            workerCallbacks.delete(id);
            reject(error);
        }
    });
}

async function ensureWorkerModelReady() {
    if (ragWorkerModelLoaded) {
        return true;
    }
    if (ragWorkerLoadPromise) {
        return ragWorkerLoadPromise;
    }

    ragWorkerLoadPromise = (async () => {
        const result = await callRagWorker('load', { modelDir: getModelDir() });
        if (!result || result.success === false) {
            throw new Error(result?.error || 'Failed to load the worker embedding model.');
        }
        ragWorkerModelLoaded = true;
        console.log('[RAG] Worker embedding model loaded successfully. Embedding backend: worker (onnxruntime-node, cpu EP).');
        return true;
    })().catch((error) => {
        ragWorkerModelLoaded = false;
        console.warn('[RAG] Worker embedding model load failed, will fall back to main-process.', error?.message || error);
        throw error;
    }).finally(() => {
        ragWorkerLoadPromise = null;
    });

    return ragWorkerLoadPromise;
}

let embeddingBackendLoggedForSession = false;

async function generateEmbeddingInWorker(text) {
    try {
        await ensureWorkerModelReady();
        const result = await callRagWorker('embed', { text });
        if (!embeddingBackendLoggedForSession) {
            embeddingBackendLoggedForSession = true;
            console.log('[RAG] Embedding backend active: worker thread (onnxruntime-node, cpu EP).');
        }
        return new Float32Array(result.vector);
    } catch (error) {
        if (!embeddingBackendLoggedForSession) {
            embeddingBackendLoggedForSession = true;
            console.warn('[RAG] Embedding backend active: main-process FALLBACK.', error?.message || error);
        } else {
            console.warn('[RAG] Worker embedding failed, falling back to main-process embedding:', error?.message || error);
        }
        await ensureModelReady();
        return generateEmbeddingInMainProcess(text);
    }
}

function normalizeTier(tier) {
    if (tier === RAG_TIER_EPISODIC) return RAG_TIER_EPISODIC;
    if (tier === RAG_TIER_BACKGROUND) return RAG_TIER_BACKGROUND;
    return RAG_TIER_CORE;
}

function getHnswState(tier) {
    return hnswStates[normalizeTier(tier)];
}

const HEADER_PATTERNS = [
    /^【Time:.*$/u,
    /^【MEMORY CHUNK.*$/u,
    /^【EPISODIC FRAGMENT】$/u,
];

const ROLE_PREFIX_PATTERN = /^(?:User|Kumiko):\s*/iu;
const EPISODIC_FRAGMENT_HEADER = '【EPISODIC FRAGMENT】';
const EPISODIC_SEGMENT_SEPARATOR = '\n---\n';
const MERGE_BLOCK_PATTERNS = [
    /(?:提醒|记得|联系我|叫我|喊我|每天|每周|每晚|schedule|remind|deadline|todo|task|约定|任务)/iu,
    /(?:报错|错误|修复|实现|逻辑|方案|原因|配置|接口|模型|向量|检索|RAG|SQLite|HNSW|embedding|endpoint|function|class|error|bug|stack|trace|prompt|code|api|model)/iu,
    /[`{}[\]();=<>]|::|=>/u,
];

function normalizeWhitespace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function getCanonicalBodyText(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !HEADER_PATTERNS.some(pattern => pattern.test(line)))
        .map(line => line.replace(ROLE_PREFIX_PATTERN, '').trim())
        .filter(Boolean)
        .join(' ');
}

function createCanonicalKeyFromRawText(text) {
    return normalizeWhitespace(
        getCanonicalBodyText(text)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    ).slice(0, 240);
}

function tokenizeCanonicalKey(canonicalKey) {
    return normalizeWhitespace(canonicalKey).split(' ').filter(Boolean);
}

function computeCanonicalTokenOverlap(a, b) {
    const aTokens = new Set(tokenizeCanonicalKey(a));
    const bTokens = new Set(tokenizeCanonicalKey(b));
    if (aTokens.size === 0 || bTokens.size === 0) return 0;

    let intersection = 0;
    aTokens.forEach(token => {
        if (bTokens.has(token)) intersection += 1;
    });

    const union = new Set([...aTokens, ...bTokens]).size;
    return union > 0 ? intersection / union : 0;
}

function inferRoleScopeFromText(text, fallbackRole = 'unknown') {
    const normalizedFallback = typeof fallbackRole === 'string' ? fallbackRole : 'unknown';
    const hasUser = /(?:^|\n)\s*User:\s*/u.test(String(text || ''));
    const hasKumiko = /(?:^|\n)\s*Kumiko:\s*/u.test(String(text || ''));

    if (hasUser && hasKumiko) return 'mixed';
    if (hasUser) return 'user';
    if (hasKumiko) return 'model';
    if (normalizedFallback === 'system') return 'unknown';
    if (['user', 'model', 'mixed', 'unknown'].includes(normalizedFallback)) {
        return normalizedFallback;
    }
    return 'unknown';
}

async function loadModelInMainProcess(modelDir) {
    if (mainProcessSession && mainProcessTokenizer) {
        activeModelBackend = 'main';
        return true;
    }

    const modelPath = path.join(modelDir, 'model_int8.onnx');
    const tokenizerPath = path.join(modelDir, 'tokenizer.json');
    if (!fs.existsSync(modelPath)) {
        throw new Error(`Model file not found: ${modelPath}`);
    }
    if (!fs.existsSync(tokenizerPath)) {
        throw new Error(`Tokenizer file not found: ${tokenizerPath}`);
    }

    const { env, AutoTokenizer } = require('@xenova/transformers');
    env.allowRemoteModels = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.localModelPath = path.dirname(modelDir);

    mainProcessOrt = requireOnnxRuntimeNode();
    mainProcessSession = await mainProcessOrt.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true,
    });

    const modelName = path.basename(modelDir);
    mainProcessTokenizer = await AutoTokenizer.from_pretrained(modelName);
    activeModelBackend = 'main';
    console.log('[RAG] Local embedding backend loaded in main process.');
    return true;
}

async function generateEmbeddingInMainProcess(text) {
    if (!mainProcessSession || !mainProcessTokenizer || !mainProcessOrt) {
        throw new Error('[RAG] Main-process model is not ready.');
    }

    const { input_ids, attention_mask } = await mainProcessTokenizer(text, {
        truncation: true,
        max_length: 512,
    });

    const inputIdsData = input_ids.data || input_ids;
    const attentionMaskData = attention_mask?.data || attention_mask;
    const inputIdsDims = Array.isArray(input_ids.dims) && input_ids.dims.length > 0
        ? input_ids.dims
        : [1, inputIdsData.length];
    const attentionMaskDims = Array.isArray(attention_mask?.dims) && attention_mask.dims.length > 0
        ? attention_mask.dims
        : inputIdsDims;
    const seqLen = inputIdsDims[inputIdsDims.length - 1];

    const inputIdsTensorData = inputIdsData instanceof BigInt64Array
        ? inputIdsData
        : BigInt64Array.from(inputIdsData, value => BigInt(value));
    const attentionMaskTensorData = attentionMaskData instanceof BigInt64Array
        ? attentionMaskData
        : BigInt64Array.from(attentionMaskData, value => BigInt(value));

    const inputIdsTensor = new mainProcessOrt.Tensor('int64', inputIdsTensorData, inputIdsDims);
    const attentionMaskTensor = new mainProcessOrt.Tensor('int64', attentionMaskTensorData, attentionMaskDims);

    const results = await mainProcessSession.run({
        input_ids: inputIdsTensor,
        attention_mask: attentionMaskTensor,
    });

    let embedding;
    if (results.sentence_embedding) {
        embedding = results.sentence_embedding.data;
    } else if (results.last_hidden_state) {
        const hidden = results.last_hidden_state.data;
        const dims = results.last_hidden_state.dims;
        const hiddenDim = dims[2];
        embedding = new Float32Array(hiddenDim);
        let validTokens = 0;

        for (let tokenIndex = 0; tokenIndex < seqLen; tokenIndex += 1) {
            if (attentionMaskData[tokenIndex] === 1) {
                for (let dimIndex = 0; dimIndex < hiddenDim; dimIndex += 1) {
                    embedding[dimIndex] += hidden[tokenIndex * hiddenDim + dimIndex];
                }
                validTokens += 1;
            }
        }

        if (validTokens > 0) {
            for (let dimIndex = 0; dimIndex < hiddenDim; dimIndex += 1) {
                embedding[dimIndex] /= validTokens;
            }
        }
    } else {
        const firstOutput = Object.values(results)[0];
        if (!firstOutput) {
            throw new Error('No valid output from ONNX model');
        }
        embedding = firstOutput.data;
    }

    let norm = 0;
    for (let index = 0; index < embedding.length; index += 1) {
        norm += embedding[index] * embedding[index];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let index = 0; index < embedding.length; index += 1) {
            embedding[index] /= norm;
        }
    }

    return new Float32Array(embedding);
}

// ==========================================
// 1. SQLite INITIALIZATION
// ==========================================
function initDatabase() {
    const dbPath = getDbPath();
    console.log(`[RAG] Initializing SQLite database at: ${dbPath}`);
    
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // P1 #20: previously WAL was enabled without a busy_timeout. Long-running
    // RAG operations (rebuild, batch embed) can coincide with backup read or
    // index maintenance and briefly contend on the write lock; without a
    // timeout better-sqlite3 surfaces SQLITE_BUSY immediately and the caller
    // sees "database is locked". 5s gives us a comfortable retry window.
    db.pragma('busy_timeout = 5000');
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS vectors (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            text TEXT NOT NULL,
            vector BLOB NOT NULL,
            timestamp INTEGER NOT NULL
        )
    `);

    const existingColumns = db.prepare(`PRAGMA table_info(vectors)`).all().map(row => row.name);
    if (!existingColumns.includes('tier')) {
        db.exec(`ALTER TABLE vectors ADD COLUMN tier TEXT`);
    }
    if (!existingColumns.includes('source')) {
        db.exec(`ALTER TABLE vectors ADD COLUMN source TEXT`);
    }
    if (!existingColumns.includes('score')) {
        db.exec(`ALTER TABLE vectors ADD COLUMN score REAL`);
    }
    if (!existingColumns.includes('canonical_key')) {
        db.exec(`ALTER TABLE vectors ADD COLUMN canonical_key TEXT`);
    }
    if (!existingColumns.includes('role')) {
        db.exec(`ALTER TABLE vectors ADD COLUMN role TEXT`);
        db.exec(`UPDATE vectors SET role = 'unknown' WHERE role IS NULL`);
    }

    db.exec(`UPDATE vectors SET tier = '${RAG_TIER_CORE}' WHERE tier IS NULL OR TRIM(tier) = ''`);
    db.exec(`UPDATE vectors SET score = 0 WHERE score IS NULL`);
    
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vectors_timestamp ON vectors(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vectors_tier_timestamp ON vectors(tier, timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vectors_canonical_key ON vectors(canonical_key)`);

    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            image TEXT,
            image_id TEXT,
            image_caption TEXT,
            grounding_sources TEXT,
            is_read INTEGER DEFAULT 0,
            is_hidden INTEGER DEFAULT 0,
            is_pinned INTEGER DEFAULT 0,
            quote_id TEXT,
            quote_text TEXT,
            quote_role TEXT,
            emotion TEXT,
            is_voice_message INTEGER DEFAULT 0,
            voice_file_id TEXT,
            voice_duration REAL,
            japanese_text TEXT
        )
    `);
    
    // Add columns if they don't exist (for existing databases)
    try {
        db.exec(`ALTER TABLE messages ADD COLUMN is_voice_message INTEGER DEFAULT 0`);
    } catch (e) { /* ignore if exists */ }
    try {
        db.exec(`ALTER TABLE messages ADD COLUMN voice_file_id TEXT`);
    } catch (e) { /* ignore if exists */ }
    try {
        db.exec(`ALTER TABLE messages ADD COLUMN voice_duration REAL`);
    } catch (e) { /* ignore if exists */ }
    try {
        db.exec(`ALTER TABLE messages ADD COLUMN japanese_text TEXT`);
    } catch (e) { /* ignore if exists */ }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_role_timestamp ON messages(role, timestamp)`);
    
    console.log(`[RAG] SQLite database initialized. Vectors count: ${getVectorCount()}`);
}

function getVectorCount(tier = null) {
    if (!db) return 0;
    const row = tier
        ? db.prepare('SELECT COUNT(*) as count FROM vectors WHERE tier = ?').get(normalizeTier(tier))
        : db.prepare('SELECT COUNT(*) as count FROM vectors').get();
    return row ? row.count : 0;
}

function getMessageCount() {
    if (!db) return 0;
    const row = db.prepare('SELECT COUNT(*) as count FROM messages').get();
    return row ? row.count : 0;
}

function getMessageLinkedVectorCount() {
    if (!db) return 0;
    const row = db.prepare('SELECT COUNT(*) as count FROM vectors WHERE message_id IS NOT NULL').get();
    return row ? row.count : 0;
}

function getHnswIndexedCount(tier) {
    const state = getHnswState(tier);
    return state.index ? state.index.getCurrentCount() : 0;
}

function getVectorStats() {
    if (!db) {
        return {
            vectorCount: 0,
            coreCount: 0,
            episodicCount: 0,
            backgroundCount: 0,
            messageLinkedCount: 0,
            messageCount: 0,
            groupedCount: 0,
            mergedCount: 0,
            sourceCounts: {},
            hnswIndexed: 0,
            coreIndexed: 0,
            episodicIndexed: 0,
            backgroundIndexed: 0,
        };
    }

    const sourceCounts = {};
    const sourceRows = db.prepare(
        `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count
         FROM vectors
         GROUP BY COALESCE(source, 'unknown')`
    ).all();
    sourceRows.forEach((row) => {
        sourceCounts[row.source] = row.count;
    });

    const coreIndexed = getHnswIndexedCount(RAG_TIER_CORE);
    const episodicIndexed = getHnswIndexedCount(RAG_TIER_EPISODIC);
    const backgroundIndexed = getHnswIndexedCount(RAG_TIER_BACKGROUND);

    return {
        vectorCount: getVectorCount(),
        coreCount: getVectorCount(RAG_TIER_CORE),
        episodicCount: getVectorCount(RAG_TIER_EPISODIC),
        backgroundCount: getVectorCount(RAG_TIER_BACKGROUND),
        messageLinkedCount: getMessageLinkedVectorCount(),
        messageCount: getMessageCount(),
        groupedCount: sourceCounts.rebuild_fragment || 0,
        mergedCount: sourceCounts.episodic_merge || 0,
        sourceCounts,
        hnswIndexed: coreIndexed + episodicIndexed + backgroundIndexed,
        coreIndexed,
        episodicIndexed,
        backgroundIndexed,
    };
}

function normalizeRawMessageRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const normalizedTimestamp = Number(raw.timestamp);
    if (typeof raw.id !== 'string' || typeof raw.text !== 'string' || !Number.isFinite(normalizedTimestamp)) return null;

    const role = raw.role === 'model' ? 'model' : raw.role === 'user' ? 'user' : null;
    if (!role) return null;

    const quote = raw.quote && typeof raw.quote === 'object' ? raw.quote : null;
    const quoteRole = quote?.role === 'user' || quote?.role === 'model' ? quote.role : null;

    return {
        id: raw.id,
        role,
        text: raw.text,
        timestamp: normalizedTimestamp,
        image: typeof raw.image === 'string' ? raw.image : null,
        imageId: typeof raw.imageId === 'string' ? raw.imageId : null,
        imageCaption: typeof raw.imageCaption === 'string' ? raw.imageCaption : null,
        groundingSources: Array.isArray(raw.groundingSources) ? JSON.stringify(raw.groundingSources) : null,
        isRead: raw.isRead ? 1 : 0,
        isHidden: raw.isHidden ? 1 : 0,
        isPinned: raw.isPinned ? 1 : 0,
        quoteId: typeof quote?.id === 'string' ? quote.id : null,
        quoteText: typeof quote?.text === 'string' ? quote.text : null,
        quoteRole,
        emotion: typeof raw.storedEmotion === 'string' ? raw.storedEmotion : null,
        isVoiceMessage: raw.isVoiceMessage ? 1 : 0,
        voiceFileId: typeof raw.voiceFileId === 'string' ? raw.voiceFileId : null,
        voiceDuration: typeof raw.voiceDuration === 'number' ? raw.voiceDuration : null,
        japaneseText: typeof raw.japaneseText === 'string' ? raw.japaneseText : null,
    };
}

function upsertRawMessages(messages, replaceAll = false) {
    if (!db) throw new Error('[RAG] Database not initialized');

    const stmt = db.prepare(`
        INSERT OR REPLACE INTO messages (
            id, role, text, timestamp, image, image_id, image_caption, grounding_sources,
            is_read, is_hidden, is_pinned, quote_id, quote_text, quote_role, emotion,
            is_voice_message, voice_file_id, voice_duration, japanese_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items, replaceExisting) => {
        if (replaceExisting) {
            db.exec('DELETE FROM messages');
        }
        for (const item of items) {
            stmt.run(
                item.id,
                item.role,
                item.text,
                item.timestamp,
                item.image,
                item.imageId,
                item.imageCaption,
                item.groundingSources,
                item.isRead,
                item.isHidden,
                item.isPinned,
                item.quoteId,
                item.quoteText,
                item.quoteRole,
                item.emotion,
                item.isVoiceMessage,
                item.voiceFileId,
                item.voiceDuration,
                item.japaneseText
            );
        }
    });

    insertMany(messages, replaceAll);
}

function getAllRawMessages() {
    if (!db) return [];
    const rows = db.prepare(`
        SELECT id, role, text, timestamp, image, image_id, image_caption, grounding_sources,
               is_read, is_hidden, is_pinned, quote_id, quote_text, quote_role, emotion,
               is_voice_message, voice_file_id, voice_duration, japanese_text
        FROM messages
        ORDER BY timestamp ASC, id ASC
    `).all();

    return rows.map(row => ({
        id: row.id,
        role: row.role === 'model' ? 'model' : 'user',
        text: row.text,
        timestamp: row.timestamp,
        image: row.image || undefined,
        imageId: row.image_id || undefined,
        imageCaption: row.image_caption || undefined,
        groundingSources: row.grounding_sources ? JSON.parse(row.grounding_sources) : undefined,
        isRead: !!row.is_read,
        isHidden: !!row.is_hidden,
        isPinned: !!row.is_pinned,
        quote: row.quote_text
            ? {
                id: row.quote_id || undefined,
                text: row.quote_text,
                role: row.quote_role === 'model' ? 'model' : 'user',
            }
            : undefined,
        storedEmotion: row.emotion || undefined,
        isVoiceMessage: !!row.is_voice_message,
        voiceFileId: row.voice_file_id || undefined,
        voiceDuration: row.voice_duration !== null ? row.voice_duration : undefined,
        japaneseText: row.japanese_text || undefined,
    }));
}

function getRawMessageContextWindow(timestamp, windowSize = 5, maxGapMs = 10 * 60 * 1000) {
    if (!db || !Number.isFinite(timestamp)) return [];

    const nearestRow = db.prepare(`
        SELECT id, role, text, timestamp, image, image_id, image_caption, grounding_sources,
               is_read, is_hidden, is_pinned, quote_id, quote_text, quote_role, emotion
        FROM messages
        WHERE ABS(timestamp - ?) <= ?
        ORDER BY ABS(timestamp - ?) ASC, timestamp ASC
        LIMIT 1
    `).get(timestamp, maxGapMs, timestamp);

    if (!nearestRow || !Number.isFinite(nearestRow.timestamp)) {
        return [];
    }

    const beforeRows = db.prepare(`
        SELECT id, role, text, timestamp, image, image_id, image_caption, grounding_sources,
               is_read, is_hidden, is_pinned, quote_id, quote_text, quote_role, emotion
        FROM messages
        WHERE timestamp < ?
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
    `).all(nearestRow.timestamp, windowSize);

    const afterRows = db.prepare(`
        SELECT id, role, text, timestamp, image, image_id, image_caption, grounding_sources,
               is_read, is_hidden, is_pinned, quote_id, quote_text, quote_role, emotion
        FROM messages
        WHERE timestamp > ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
    `).all(nearestRow.timestamp, windowSize);

    return [...beforeRows.reverse(), nearestRow, ...afterRows].map(row => ({
        messageId: row.id,
        text: row.text,
        timestamp: row.timestamp,
        role: row.role === 'model' ? 'model' : 'user',
    }));
}

// ==========================================
// 2. HNSW INDEX INITIALIZATION
// ==========================================
function initSingleHnswIndex(tier, maxElements = 50000) {
    try {
        const { HierarchicalNSW } = require('hnswlib-node');

        const state = createHnswState();
        state.index = new HierarchicalNSW('cosine', EMBEDDING_DIM);
        state.index.initIndex(maxElements, HNSW_M, HNSW_EF_CONSTRUCTION);
        state.index.setEf(HNSW_EF_SEARCH);
        hnswStates[normalizeTier(tier)] = state;

        console.log(`[RAG] HNSW index initialized for ${normalizeTier(tier)} (maxElements: ${maxElements}, M: ${HNSW_M}, efConstruction: ${HNSW_EF_CONSTRUCTION})`);
    } catch (e) {
        console.error(`[RAG] Failed to initialize ${normalizeTier(tier)} HNSW index:`, e);
        hnswStates[normalizeTier(tier)] = createHnswState();
    }
}

function initHnswIndexes(coreMaxElements = 50000, episodicMaxElements = 50000, backgroundMaxElements = 50000) {
    initSingleHnswIndex(RAG_TIER_CORE, coreMaxElements);
    initSingleHnswIndex(RAG_TIER_EPISODIC, episodicMaxElements);
    initSingleHnswIndex(RAG_TIER_BACKGROUND, backgroundMaxElements);
}

const HNSW_REBUILD_YIELD_BATCH = 50;

async function rebuildHnswFromSqlite() {
    if (!db) return;

    const rows = db.prepare('SELECT id, vector, tier FROM vectors ORDER BY timestamp ASC').all();
    if (rows.length === 0) {
        console.log('[RAG] No vectors in SQLite to rebuild HNSW index from.');
        initHnswIndexes();
        return;
    }

    const coreRows = rows.filter(row => normalizeTier(row.tier) === RAG_TIER_CORE);
    const episodicRows = rows.filter(row => normalizeTier(row.tier) === RAG_TIER_EPISODIC);
    const backgroundRows = rows.filter(row => normalizeTier(row.tier) === RAG_TIER_BACKGROUND);
    initHnswIndexes(
        Math.max(coreRows.length * 2, 1000),
        Math.max(episodicRows.length * 2, 1000),
        Math.max(backgroundRows.length * 2, 1000)
    );

    let added = 0;
    for (let i = 0; i < rows.length; i++) {
        if (i > 0 && i % HNSW_REBUILD_YIELD_BATCH === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
        const row = rows[i];
        try {
            const vector = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
            if (vector.length === EMBEDDING_DIM) {
                const state = getHnswState(row.tier);
                const label = state.nextLabel++;
                state.index.addPoint(Array.from(vector), label);
                state.idMap.set(label, row.id);
                state.reverseMap.set(row.id, label);
                added++;
            }
        } catch (e) {
            console.warn(`[RAG] Skipped vector ${row.id} during rebuild:`, e.message);
        }
    }

    console.log(`[RAG] HNSW indexes rebuilt from SQLite: ${added}/${rows.length} vectors indexed. core=${coreRows.length}, episodic=${episodicRows.length}, background=${backgroundRows.length}`);
}

function addToHnswIndex(id, vector, tier = RAG_TIER_CORE) {
    const state = getHnswState(tier);
    if (!state.index) return;
    
    try {
        // Dynamic capacity scaling
        const currentCount = state.index.getCurrentCount();
        const maxElements = state.index.getMaxElements();
        if (currentCount >= maxElements - 100) { // Keep a buffer of 100 before resizing
            const newSize = maxElements + 50000;
            console.log(`[RAG] Expanding ${tier} HNSW index size from ${maxElements} to ${newSize}...`);
            state.index.resizeIndex(newSize);
        }

        const label = state.nextLabel++;
        state.index.addPoint(Array.from(vector), label);
        state.idMap.set(label, id);
        state.reverseMap.set(id, label);
    } catch (e) {
        console.error(`[RAG] Failed to add vector to ${tier} index:`, e);
    }
}

function removeFromHnswIndex(id, tier = RAG_TIER_CORE) {
    const state = getHnswState(tier);
    if (!state.index) return;

    const label = state.reverseMap.get(id);
    if (label === undefined) return;

    try {
        state.index.markDelete(label);
    } catch (e) {
        console.warn(`[RAG] Failed to mark-delete ${normalizeTier(tier)} HNSW point ${id}:`, e.message);
    }

    state.idMap.delete(label);
    state.reverseMap.delete(id);
}

function replaceInHnswIndex(id, vector, tier = RAG_TIER_CORE) {
    removeFromHnswIndex(id, tier);
    addToHnswIndex(id, vector, tier);
}

function clearAllVectors() {
    if (!db) throw new Error('[RAG] Database not initialized');

    db.prepare('DELETE FROM vectors').run();
    initHnswIndexes();

    console.log('[RAG] Cleared all vectors from SQLite and reset HNSW indexes.');
    return 0;
}

function deleteMessageVectorsOnly() {
    if (!db) throw new Error('[RAG] Database not initialized');
    const result = db.prepare('DELETE FROM vectors WHERE message_id IS NOT NULL').run();
    return result.changes;
}

async function clearMessageVectors() {
    const deletedCount = deleteMessageVectorsOnly();
    await rebuildHnswFromSqlite();

    console.log(`[RAG] Cleared ${deletedCount} message-linked vectors from SQLite and rebuilt HNSW indexes.`);
    return deletedCount;
}

// ==========================================
// 3. ONNX MODEL LOADING
// ==========================================
async function loadModel() {
    if (isModelLoaded && activeModelBackend === 'main' && mainProcessSession && mainProcessTokenizer) {
        return true;
    }
    if (modelLoadPromise) {
        return modelLoadPromise;
    }

    const modelDir = getModelDir();
    modelLoadPromise = (async () => {
        try {
            await loadModelInMainProcess(modelDir);
            isModelLoaded = true;
            modelLoadError = null;
            return true;
        } catch (error) {
            console.error('[RAG] Failed to load local model in main process:', error);
            isModelLoaded = false;
            modelLoadError = error.message;
            activeModelBackend = 'none';
            return false;
        } finally {
            modelLoadPromise = null;
        }
    })();

    return modelLoadPromise;
}

async function ensureModelReady() {
    const loaded = await loadModel();
    const mainReady = activeModelBackend === 'main' && !!mainProcessSession && !!mainProcessTokenizer;
    if (!loaded || !isModelLoaded || !mainReady) {
        throw new Error(`[RAG] Local model failed to load: ${modelLoadError || 'Unknown error'}`);
    }
}

// ==========================================
// 4. EMBEDDING GENERATION
// ==========================================
async function generateEmbedding(text) {
    // v2.14.28 M18: prefer the worker thread for incremental embedding too —
    // rebuild was already worker-routed but the rag:save / rag:embed
    // call sites went through generateEmbeddingInMainProcess, which paid
    // for ONNX inference on the Electron main thread (= UI thread for
    // background-process-y purposes) and could spike for several hundred
    // ms during a chat send. generateEmbeddingInWorker has its own
    // graceful fallback to main-process embedding when the worker is
    // unavailable, so this is a pure scheduling improvement with no
    // behavior change on the unhappy path.
    return generateEmbeddingInWorker(text);
}

// ==========================================
// 6. HYBRID SEARCH (HNSW + BM25 + RRF)
// ==========================================

function tokenize(text) {
    if (!text) return [];
    const cleaned = text.toLowerCase().replace(/[^\w\s\u4e00-\u9fa5]/g, ' ');
    const tokens = [];
    const parts = cleaned.split(/\s+/).filter(t => t.length > 0);
    for (const part of parts) {
        if (/[\u4e00-\u9fa5]/.test(part)) {
            const cjk = part.replace(/[^\u4e00-\u9fa5]/g, '');
            for (let i = 0; i < cjk.length - 1; i++) {
                tokens.push(cjk[i] + cjk[i + 1]);
            }
            if (cjk.length === 1) tokens.push(cjk);
            const nonCjk = part.replace(/[\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean);
            tokens.push(...nonCjk);
        } else {
            tokens.push(part);
        }
    }
    return tokens;
}

function calculateBM25(queryTokens, docs) {
    const k1 = 1.2, b = 0.75;
    const N = docs.length;
    if (N === 0) return new Map();
    
    const avgdl = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / N;
    
    const df = new Map();
    docs.forEach(doc => {
        const unique = new Set(doc.tokens);
        unique.forEach(token => df.set(token, (df.get(token) || 0) + 1));
    });
    
    const idf = new Map();
    df.forEach((freq, token) => {
        idf.set(token, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
    });
    
    const scores = new Map();
    docs.forEach(doc => {
        let score = 0;
        const docLen = doc.tokens.length;
        const tf = new Map();
        doc.tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
        
        queryTokens.forEach(token => {
            if (tf.has(token) && idf.has(token)) {
                const termFreq = tf.get(token);
                const idfScore = idf.get(token);
                score += idfScore * ((termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + b * (docLen / avgdl))));
            }
        });
        
        scores.set(doc.id, score);
    });
    
    return scores;
}

function computeRRF(vectorResults, bm25Results, k = 60) {
    const rrfScores = new Map();
    
    vectorResults.forEach((item, index) => {
        rrfScores.set(item.id, 1 / (k + index + 1));
    });
    
    bm25Results.forEach((item, index) => {
        const current = rrfScores.get(item.id) || 0;
        rrfScores.set(item.id, current + 1 / (k + index + 1));
    });
    
    return rrfScores;
}

function getTierSearchRows(tier, filters = {}) {
    let query = 'SELECT id, message_id, text, vector, timestamp, tier, source, score, canonical_key, role FROM vectors WHERE tier = ?';
    const params = [normalizeTier(tier)];
    
    if (typeof filters.startTime === 'number') {
        query += ' AND timestamp >= ?';
        params.push(filters.startTime);
    }
    if (typeof filters.endTime === 'number') {
        query += ' AND timestamp <= ?';
        params.push(filters.endTime);
    }
    if (filters.role && filters.role !== 'any') {
        query += ' AND role = ?';
        params.push(filters.role);
    }
    
    return db.prepare(query).all(...params);
}

function computeCosineSimilarity(queryVector, storedVector) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < EMBEDDING_DIM; i++) {
        dot += queryVector[i] * storedVector[i];
        normA += queryVector[i] * queryVector[i];
        normB += storedVector[i] * storedVector[i];
    }

    return (normA && normB) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function boostHybridScore(rrfScore, memoryScore, tier = RAG_TIER_CORE, source = 'unknown', role = 'unknown', memoryIntent = 'default', keywordScore = 0) {
    const normalizedMemoryScore = Math.max(0, Math.min(Number.isFinite(memoryScore) ? memoryScore : 0, 12));
    let boostedScore = rrfScore + (normalizedMemoryScore * 0.015);

    if (tier === RAG_TIER_EPISODIC) {
        boostedScore -= 0.015;
    } else if (tier === RAG_TIER_BACKGROUND) {
        boostedScore -= 0.08;
    }

    if (source === 'turn_pair') {
        boostedScore -= 0.02;
    } else if (source === 'episodic_merge') {
        boostedScore -= 0.01;
    }

    if (role === 'mixed') {
        boostedScore -= 0.015;
    }

    if (memoryIntent === 'semantic_recall') {
        if (source === 'memory_chunk') {
            boostedScore += 0.035;
        } else if (source === 'turn_pair') {
            boostedScore -= 0.035;
        } else if (source === 'rebuild_fragment' || source === 'episodic_merge') {
            boostedScore += 0.01;
        }
        if (keywordScore > 0) {
            boostedScore += 0.05;
        }
    }

    return boostedScore;
}

function getCanonicalDuplicateRow(canonicalKey) {
    if (!canonicalKey) return null;
    return db.prepare(
        `SELECT id, tier, source, timestamp
         FROM vectors
         WHERE canonical_key = ?
         ORDER BY CASE tier
             WHEN '${RAG_TIER_CORE}' THEN 0
             WHEN '${RAG_TIER_EPISODIC}' THEN 1
             ELSE 2
         END, timestamp DESC
         LIMIT 1`
    ).get(canonicalKey);
}

function shouldSkipCanonicalDuplicate(canonicalKey, tier, source, ignoreId = null) {
    const existing = getCanonicalDuplicateRow(canonicalKey);
    if (!existing) return false;
    if (ignoreId && existing.id === ignoreId) return false;

    const existingTier = normalizeTier(existing.tier);
    const nextTier = normalizeTier(tier);
    const existingSource = typeof existing.source === 'string' ? existing.source : 'unknown';
    const nextSource = typeof source === 'string' && source.trim() ? source.trim() : 'unknown';

    if (existingTier === nextTier) {
        return true;
    }

    if (existingTier === RAG_TIER_CORE && nextTier === RAG_TIER_EPISODIC) {
        return true;
    }

    if (existingTier === RAG_TIER_CORE && nextTier === RAG_TIER_BACKGROUND) {
        return true;
    }

    if (existingTier === RAG_TIER_EPISODIC && nextTier === RAG_TIER_BACKGROUND) {
        return true;
    }

    if (existingSource === 'memory_chunk' && nextSource !== 'memory_chunk') {
        return true;
    }

    return false;
}

function getRetrievalDedupeKey(result) {
    if (result.canonicalKey) {
        return `canonical:${result.canonicalKey}`;
    }
    if (result.messageId) {
        return `message:${result.messageId}`;
    }
    return `text:${String(result.text || '').trim().toLowerCase().slice(0, 160)}`;
}

function compareRetrievedResults(a, b) {
    const getTierRank = (tier) => tier === RAG_TIER_CORE ? 0 : tier === RAG_TIER_EPISODIC ? 1 : 2;
    const tierRank = getTierRank(a.tier) - getTierRank(b.tier);
    if (tierRank !== 0) return tierRank;
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return (b.timestamp || 0) - (a.timestamp || 0);
}

function dedupeRetrievedResults(results, topK) {
    const seen = new Set();
    const deduped = [];

    for (const result of [...results].sort(compareRetrievedResults)) {
        const key = getRetrievalDedupeKey(result);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(result);
        if (deduped.length >= topK) break;
    }

    return deduped;
}

function isEligibleForEpisodicMerge(text, source, score) {
    if (source === 'memory_chunk') return false;
    if (Number.isFinite(score) && Number(score) > 4.5) return false;

    const normalizedText = normalizeWhitespace(String(text || ''));
    if (!normalizedText) return false;
    if (normalizedText.length > 420) return false;

    return !MERGE_BLOCK_PATTERNS.some(pattern => pattern.test(normalizedText));
}

function extractEpisodicFragmentSegments(text) {
    const body = String(text || '')
        .replace(/^【EPISODIC FRAGMENT】\s*/u, '')
        .trim();

    return body
        ? body.split(EPISODIC_SEGMENT_SEPARATOR).map(segment => segment.trim()).filter(Boolean)
        : [];
}

function buildMergedEpisodicText(existingText, nextText) {
    const existingSegments = extractEpisodicFragmentSegments(existingText);
    const nextSegments = extractEpisodicFragmentSegments(nextText);
    const segments = [...existingSegments, ...nextSegments];

    const dedupedSegments = [];
    let previous = null;
    for (const segment of segments) {
        const normalizedSegment = normalizeWhitespace(segment);
        if (!normalizedSegment || normalizedSegment === previous) continue;
        dedupedSegments.push(segment.trim());
        previous = normalizedSegment;
    }

    const finalSegments = dedupedSegments.slice(-EPISODIC_MERGE_MAX_SEGMENTS);
    return `${EPISODIC_FRAGMENT_HEADER}\n${finalSegments.join(EPISODIC_SEGMENT_SEPARATOR)}`;
}

function findRecentEpisodicMergeTarget({ canonicalKey, vector, timestamp, source, score }) {
    if (!canonicalKey || !isEligibleForEpisodicMerge(canonicalKey, source, score)) {
        return null;
    }

    const recentRows = db.prepare(
        `SELECT id, message_id, text, vector, timestamp, tier, source, score, canonical_key, role
         FROM vectors
         WHERE tier = ? AND timestamp BETWEEN ? AND ?
         ORDER BY timestamp DESC
         LIMIT ?`
    ).all(
        RAG_TIER_EPISODIC,
        timestamp - EPISODIC_MERGE_WINDOW_MS,
        timestamp,
        EPISODIC_MERGE_MAX_CANDIDATES
    );

    let bestCandidate = null;

    for (const row of recentRows) {
        if (!row || !isEligibleForEpisodicMerge(row.text, row.source, row.score)) continue;

        const storedVector = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
        const vectorSimilarity = computeCosineSimilarity(vector, storedVector);
        const tokenOverlap = computeCanonicalTokenOverlap(canonicalKey, row.canonical_key || '');
        const veryCloseInTime = Math.abs(timestamp - row.timestamp) <= (8 * 60 * 1000);
        const qualifies = vectorSimilarity >= EPISODIC_MERGE_MIN_VECTOR_SIMILARITY
            || tokenOverlap >= EPISODIC_MERGE_MIN_TOKEN_OVERLAP
            || (veryCloseInTime && vectorSimilarity >= 0.48)
            || (veryCloseInTime && tokenOverlap >= 0.08);

        if (!qualifies) continue;

        const agePenalty = Math.max(0, timestamp - row.timestamp) / EPISODIC_MERGE_WINDOW_MS;
        const combinedScore = (vectorSimilarity * 0.75) + (tokenOverlap * 0.25) - (agePenalty * 0.1);

        if (!bestCandidate || combinedScore > bestCandidate.combinedScore) {
            bestCandidate = {
                row,
                combinedScore,
            };
        }
    }

    return bestCandidate?.row || null;
}

function searchTierVectors(queryVector, queryTokens, tier, topK = 5, filters = {}, memoryIntent = 'default') {
    const normalizedTier = normalizeTier(tier);
    // Note: tierCount is the total vector count, not the filtered count.
    
    const hasFilters = Object.keys(filters).length > 0;
    let vectorCandidates = [];
    const hnswK = Math.max(topK * 5, 25);
    
    const state = getHnswState(normalizedTier);

    // Only use HNSW if there are no exact SQL filters. If there are temporal filters, 
    // HNSW might return vectors outside the time range, so we rely on SQLite + Brute-force Cosine for 100% accuracy.
    if (!hasFilters && state.index && state.index.getCurrentCount() > 0) {
        try {
            const currentCount = state.index.getCurrentCount();
            const searchK = Math.min(hnswK, currentCount);
            const result = state.index.searchKnn(Array.from(queryVector), searchK);
            for (let i = 0; i < result.neighbors.length; i++) {
                const label = result.neighbors[i];
                const distance = result.distances[i];
                const sqliteId = state.idMap.get(label);
                if (sqliteId) {
                    vectorCandidates.push({ id: sqliteId, score: 1 - distance });
                }
            }
            vectorCandidates.sort((a, b) => b.score - a.score);
            console.log(`[RAG] ${normalizedTier} HNSW search returned ${vectorCandidates.length} candidates.`);
        } catch (e) {
            console.warn(`[RAG] ${normalizedTier} HNSW search failed, falling back to brute-force:`, e.message);
            vectorCandidates = [];
        }
    }

    const allRows = getTierSearchRows(normalizedTier, filters);
    
    if (allRows.length === 0) return [];

    if (vectorCandidates.length === 0) {
        if (hasFilters) console.log(`[RAG] Temporal filters active. Using exact brute-force cosine search for ${normalizedTier} (${allRows.length} candidates in time window).`);
        else console.log(`[RAG] Using brute-force cosine search for ${normalizedTier}.`);
        
        vectorCandidates = allRows
            .map(row => {
                const storedVector = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
                return {
                    id: row.id,
                    score: computeCosineSimilarity(queryVector, storedVector),
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, hnswK);
    }

    const docsForBM25 = allRows.map(row => ({ id: row.id, tokens: tokenize(row.text) }));
    const bm25ScoreMap = calculateBM25(queryTokens, docsForBM25);
    const bm25Results = allRows
        .map(row => ({ id: row.id, score: bm25ScoreMap.get(row.id) || 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, hnswK);

    const rrfScores = computeRRF(vectorCandidates, bm25Results);
    const candidateIds = new Set([
        ...vectorCandidates.map(candidate => candidate.id),
        ...bm25Results.filter(candidate => candidate.score > 0).map(candidate => candidate.id),
    ]);

    const rowMap = new Map();
    allRows.forEach(row => rowMap.set(row.id, row));

    const vectorScoreMap = new Map(vectorCandidates.map(candidate => [candidate.id, candidate.score]));
    const keywordScoreMap = new Map(bm25Results.map(candidate => [candidate.id, candidate.score]));

    const results = Array.from(candidateIds).map(id => {
        const row = rowMap.get(id);
        const vectorScore = vectorScoreMap.get(id) || 0;
        const keywordScore = keywordScoreMap.get(id) || 0;
        const fusionScore = rrfScores.get(id) || 0;
        const memoryScore = row?.score || 0;

        return {
            text: row ? row.text : '',
            messageId: row ? row.message_id : undefined,
            tier: normalizedTier,
            source: row ? row.source : undefined,
            canonicalKey: row ? row.canonical_key : undefined,
            timestamp: row ? row.timestamp : 0,
            score: boostHybridScore(
                fusionScore,
                memoryScore,
                normalizedTier,
                row ? row.source : undefined,
                row ? row.role : undefined,
                memoryIntent,
                keywordScore
            ),
            vectorScore,
            keywordScore,
            memoryScore,
            role: row ? row.role : undefined,
        };
    });

    return results
        .sort((a, b) => b.score - a.score)
        .filter(result => result.vectorScore > 0.1 || result.keywordScore > 0)
        .slice(0, topK);
}

function searchByKeywords(keywords, topK, filters) {
    if (!db || !keywords || keywords.length === 0) return [];
    const safeKeywords = keywords
        .map(k => String(k || '').trim())
        .filter(k => k.length > 0);
    if (safeKeywords.length === 0) return [];

    const conditions = safeKeywords.map(() => `text LIKE '%' || ? || '%'`);
    const params = [...safeKeywords];

    let timeClauses = '';
    if (filters.startTime) {
        timeClauses += ' AND timestamp >= ?';
        params.push(filters.startTime);
    }
    if (filters.endTime) {
        timeClauses += ' AND timestamp <= ?';
        params.push(filters.endTime);
    }

    params.push(topK * 2);
    const sql = `SELECT id, text, message_id, tier, source, canonical_key, timestamp, role, score
        FROM vectors
        WHERE (${conditions.join(' OR ')})${timeClauses}
        ORDER BY timestamp DESC
        LIMIT ?`;

    try {
        const rows = db.prepare(sql).all(...params);
        return rows.map(row => ({
            text: row.text || '',
            messageId: row.message_id || undefined,
            tier: normalizeTier(row.tier),
            source: row.source || undefined,
            canonicalKey: row.canonical_key || undefined,
            timestamp: row.timestamp || 0,
            score: 0.04 + (row.score || 0) * 0.005,
            vectorScore: 0,
            keywordScore: 1.0,
            memoryScore: row.score || 0,
            role: row.role || undefined,
        }));
    } catch (err) {
        console.error('[RAG] searchByKeywords error:', err?.message || err);
        return [];
    }
}

async function searchVectors(query, topK = 5, filters = {}, memoryIntent = 'default', keywords = []) {
    if (!db) throw new Error('[RAG] Database not initialized');

    const vectorCount = getVectorCount();
    if (vectorCount === 0) return [];

    const queryVector = await generateEmbedding(query);
    const baseTokens = tokenize(query);
    const extraTokens = Array.isArray(keywords)
        ? keywords.flatMap(k => tokenize(String(k || '')))
        : [];
    const queryTokens = [...new Set([...baseTokens, ...extraTokens])];
    const isSemanticRecall = memoryIntent === 'semantic_recall';

    const coreResults = searchTierVectors(queryVector, queryTokens, RAG_TIER_CORE, topK * 2, filters, memoryIntent);
    const dedupedCoreResults = dedupeRetrievedResults(coreResults, topK);
    if (!isSemanticRecall && dedupedCoreResults.length >= topK) {
        const finalResults = dedupedCoreResults.slice(0, topK);
        console.log('[RAG] Retrieval route:', {
            query: String(query || '').slice(0, 80),
            filters,
            route: 'core_only',
            returned: finalResults.length,
            tiers: finalResults.reduce((acc, item) => {
                acc[item.tier] = (acc[item.tier] || 0) + 1;
                return acc;
            }, {}),
        });
        return finalResults.map(result => ({
            text: result.text,
            messageId: result.messageId,
            tier: result.tier,
            source: result.source,
            timestamp: result.timestamp,
            role: result.role,
        }));
    }

    const episodicResults = searchTierVectors(queryVector, queryTokens, RAG_TIER_EPISODIC, topK * 2, filters, memoryIntent);
    const dedupedCoreAndEpisodic = dedupeRetrievedResults([...dedupedCoreResults, ...episodicResults], topK);
    const minimumStablePrimaryResults = topK <= 1 ? 1 : Math.min(topK, 2);
    if (!isSemanticRecall && (dedupedCoreAndEpisodic.length >= topK || dedupedCoreAndEpisodic.length >= minimumStablePrimaryResults)) {
        const finalResults = dedupedCoreAndEpisodic.slice(0, topK);
        console.log('[RAG] Retrieval route:', {
            query: String(query || '').slice(0, 80),
            filters,
            route: 'core_plus_episodic',
            returned: finalResults.length,
            tiers: finalResults.reduce((acc, item) => {
                acc[item.tier] = (acc[item.tier] || 0) + 1;
                return acc;
            }, {}),
        });
        return finalResults.map(result => ({
            text: result.text,
            messageId: result.messageId,
            tier: result.tier,
            source: result.source,
            timestamp: result.timestamp,
            role: result.role,
        }));
    }

    const canUseBackgroundSupplement = isSemanticRecall || !(filters.role && filters.role !== 'any');
    const backgroundBudget = canUseBackgroundSupplement
        ? (isSemanticRecall ? topK : Math.max(1, topK - dedupedCoreAndEpisodic.length))
        : 0;
    const backgroundResults = backgroundBudget > 0
        ? searchTierVectors(queryVector, queryTokens, RAG_TIER_BACKGROUND, backgroundBudget, filters, memoryIntent)
        : [];

    let allHybridResults = dedupeRetrievedResults([...dedupedCoreAndEpisodic, ...backgroundResults], topK * 2);

    const safeKeywords = Array.isArray(keywords) ? keywords.filter(k => String(k || '').trim()) : [];
    let keywordReserved = [];
    if (isSemanticRecall && safeKeywords.length > 0) {
        const keywordDirectHits = searchByKeywords(safeKeywords, topK, filters);
        if (keywordDirectHits.length > 0) {
            const existingKeys = new Set(allHybridResults.map(getRetrievalDedupeKey));
            const uniqueKeywordHits = keywordDirectHits.filter(r => {
                const key = getRetrievalDedupeKey(r);
                return !key || !existingKeys.has(key);
            });
            const reserve = Math.min(uniqueKeywordHits.length, Math.ceil(topK / 3));
            keywordReserved = uniqueKeywordHits.slice(0, reserve);
            console.log('[RAG] Keyword direct search supplemented:', {
                keywordHits: keywordDirectHits.length,
                uniqueNew: uniqueKeywordHits.length,
                reserved: keywordReserved.length,
                keywords: safeKeywords.slice(0, 5),
            });
        }
    }

    const hybridSlots = topK - keywordReserved.length;
    const finalResults = [...allHybridResults.slice(0, hybridSlots), ...keywordReserved];
    const routeLabel = backgroundResults.length > 0
        ? (safeKeywords.length > 0 ? 'all_tiers_plus_keyword' : 'all_tiers')
        : (safeKeywords.length > 0 ? 'hybrid_plus_keyword' : 'primary_only_short');
    console.log('[RAG] Retrieval route:', {
        query: String(query || '').slice(0, 80),
        filters,
        route: routeLabel,
        returned: finalResults.length,
        tiers: finalResults.reduce((acc, item) => {
            acc[item.tier] = (acc[item.tier] || 0) + 1;
            return acc;
        }, {}),
    });
    return finalResults.map(result => ({
            text: result.text,
            messageId: result.messageId,
            tier: result.tier,
            source: result.source,
            timestamp: result.timestamp,
            role: result.role,
        }));
}

function createRagVectorId() {
    return `${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

function buildRebuildJobPayload(job, overrides = {}) {
    return {
        jobId: job.id,
        stage: job.stage,
        processed: Number.isFinite(job.processed) ? job.processed : null,
        total: Number.isFinite(job.total) ? job.total : null,
        extra: job.extra || null,
        elapsedMs: Math.max(0, Date.now() - job.startedAt),
        candidateCount: job.candidateCount || 0,
        filteredCount: job.filteredCount || 0,
        duplicateCount: job.duplicateCount || 0,
        groupedCount: job.groupedCount || 0,
        storedCount: job.storedCount || 0,
        mergedCount: job.mergedCount || 0,
        skippedExistingCount: job.skippedExistingCount || 0,
        clearedCount: job.clearedCount || 0,
        finalStats: job.finalStats || null,
        ...overrides,
    };
}

function createRebuildJob(sender) {
    return {
        id: `rag-rebuild-${Date.now()}-${++rebuildJobCounter}`,
        sender,
        startedAt: Date.now(),
        stage: 'loading_source_history',
        processed: 0,
        total: 0,
        extra: null,
        candidateCount: 0,
        filteredCount: 0,
        duplicateCount: 0,
        groupedCount: 0,
        storedCount: 0,
        mergedCount: 0,
        skippedExistingCount: 0,
        clearedCount: 0,
        finalStats: null,
        lastProgressSentAt: 0,
        pendingProgressPayload: null,
        progressTimer: null,
    };
}

function safeSendRebuildEvent(job, channel, payload) {
    if (!job?.sender || job.sender.isDestroyed()) {
        return false;
    }
    try {
        job.sender.send(channel, payload);
        return true;
    } catch (error) {
        console.warn(`[RAG REBUILD] Failed to send ${channel}:`, error?.message || error);
        return false;
    }
}

function clearRebuildProgressTimer(job) {
    if (!job) return;
    if (job.progressTimer) {
        clearTimeout(job.progressTimer);
        job.progressTimer = null;
    }
    job.pendingProgressPayload = null;
}

function flushRebuildProgress(job) {
    if (!job?.pendingProgressPayload) return;
    const payload = job.pendingProgressPayload;
    job.pendingProgressPayload = null;
    job.lastProgressSentAt = Date.now();
    safeSendRebuildEvent(job, 'rag:rebuild:progress', payload);
}

function updateRebuildJobProgress(job, update = {}, force = false) {
    if (!job || activeRebuildJob !== job) return;
    // Log stage transitions (but not every throttled progress tick) so the
    // main-process log file has a running timeline when someone needs to
    // diagnose a stall — e.g. the mobile "stuck at 1/6" symptom. A stage
    // transition is any call where `update.stage` is set and differs from
    // the previous stage.
    if (typeof update.stage === 'string' && update.stage !== job.stage) {
        const processed = typeof update.processed === 'number' ? update.processed
            : (typeof job.processed === 'number' ? job.processed : null);
        const total = typeof update.total === 'number' ? update.total
            : (typeof job.total === 'number' ? job.total : null);
        console.log(`[RAG REBUILD] stage transition ${job.stage ?? 'init'} -> ${update.stage} processed=${processed ?? '?'} total=${total ?? '?'} elapsedMs=${Date.now() - (job.startedAt || Date.now())}`);
    }
    Object.assign(job, update);

    const payload = buildRebuildJobPayload(job);
    if (force) {
        clearRebuildProgressTimer(job);
        job.lastProgressSentAt = Date.now();
        safeSendRebuildEvent(job, 'rag:rebuild:progress', payload);
        return;
    }

    const elapsedSinceLastSend = job.lastProgressSentAt ? (Date.now() - job.lastProgressSentAt) : Number.POSITIVE_INFINITY;
    if (elapsedSinceLastSend >= REBUILD_PROGRESS_THROTTLE_MS) {
        job.lastProgressSentAt = Date.now();
        safeSendRebuildEvent(job, 'rag:rebuild:progress', payload);
        return;
    }

    job.pendingProgressPayload = payload;
    if (!job.progressTimer) {
        job.progressTimer = setTimeout(() => {
            job.progressTimer = null;
            if (activeRebuildJob !== job) return;
            flushRebuildProgress(job);
        }, Math.max(0, REBUILD_PROGRESS_THROTTLE_MS - elapsedSinceLastSend));
    }
}

function finishRebuildJob(job, channel, overrides = {}) {
    if (!job) return;
    clearRebuildProgressTimer(job);
    const payload = buildRebuildJobPayload(job, overrides);
    safeSendRebuildEvent(job, channel, payload);
    if (activeRebuildJob === job) {
        activeRebuildJob = null;
    }
}

function getCanonicalTierRank(tier) {
    const normalizedTier = normalizeTier(tier);
    if (normalizedTier === RAG_TIER_CORE) return 0;
    if (normalizedTier === RAG_TIER_EPISODIC) return 1;
    return 2;
}

function compareCanonicalDuplicatePreference(a, b) {
    const tierRank = getCanonicalTierRank(a?.tier) - getCanonicalTierRank(b?.tier);
    if (tierRank !== 0) return tierRank;
    return (Number(b?.timestamp) || 0) - (Number(a?.timestamp) || 0);
}

function getCanonicalDuplicateRowFromIndex(canonicalRowsByKey, canonicalKey) {
    if (!canonicalKey) return null;
    const rows = canonicalRowsByKey.get(canonicalKey);
    if (!rows || rows.size === 0) return null;

    let bestRow = null;
    rows.forEach((row) => {
        if (!bestRow || compareCanonicalDuplicatePreference(row, bestRow) < 0) {
            bestRow = row;
        }
    });
    return bestRow;
}

function upsertCanonicalRowInIndex(canonicalRowsByKey, row) {
    if (!row?.canonicalKey) return;
    const key = row.canonicalKey;
    let rows = canonicalRowsByKey.get(key);
    if (!rows) {
        rows = new Map();
        canonicalRowsByKey.set(key, rows);
    }
    rows.set(row.id, row);
}

function removeCanonicalRowFromIndex(canonicalRowsByKey, row) {
    if (!row?.canonicalKey) return;
    const rows = canonicalRowsByKey.get(row.canonicalKey);
    if (!rows) return;
    rows.delete(row.id);
    if (rows.size === 0) {
        canonicalRowsByKey.delete(row.canonicalKey);
    }
}

function shouldSkipCanonicalDuplicateFromIndex(canonicalRowsByKey, canonicalKey, tier, source) {
    const existing = getCanonicalDuplicateRowFromIndex(canonicalRowsByKey, canonicalKey);
    if (!existing) return false;

    const existingTier = normalizeTier(existing.tier);
    const nextTier = normalizeTier(tier);
    const existingSource = typeof existing.source === 'string' ? existing.source : 'unknown';
    const nextSource = typeof source === 'string' && source.trim() ? source.trim() : 'unknown';

    if (existingTier === nextTier) {
        return true;
    }

    if (existingTier === RAG_TIER_CORE && nextTier === RAG_TIER_EPISODIC) {
        return true;
    }

    if (existingTier === RAG_TIER_CORE && nextTier === RAG_TIER_BACKGROUND) {
        return true;
    }

    if (existingTier === RAG_TIER_EPISODIC && nextTier === RAG_TIER_BACKGROUND) {
        return true;
    }

    if (existingSource === 'memory_chunk' && nextSource !== 'memory_chunk') {
        return true;
    }

    return false;
}

function getRebuildBaseCanonicalRows() {
    if (!db) return [];
    return db.prepare(
        `SELECT id, tier, source, timestamp, canonical_key
         FROM vectors
         WHERE message_id IS NULL AND canonical_key IS NOT NULL`
    ).all().map((row) => ({
        id: row.id,
        tier: normalizeTier(row.tier),
        source: typeof row.source === 'string' && row.source.trim() ? row.source.trim() : 'unknown',
        timestamp: Number(row.timestamp) || 0,
        canonicalKey: row.canonical_key,
    }));
}

function getRebuildBaseEpisodicRows() {
    if (!db) return [];
    const rows = db.prepare(
        `SELECT id, text, vector, timestamp, tier, source, score, canonical_key, role
         FROM vectors
         WHERE message_id IS NULL AND tier = ?
         ORDER BY timestamp DESC`
    ).all(RAG_TIER_EPISODIC);

    return rows.map((row) => {
        const vector = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
        if (vector.length !== EMBEDDING_DIM) {
            return null;
        }
        return {
            id: row.id,
            messageId: null,
            text: row.text,
            vector,
            timestamp: Number(row.timestamp) || 0,
            tier: RAG_TIER_EPISODIC,
            source: typeof row.source === 'string' && row.source.trim() ? row.source.trim() : 'unknown',
            score: Number.isFinite(row.score) ? Number(row.score) : 0,
            canonicalKey: row.canonical_key || null,
            role: typeof row.role === 'string' ? row.role : 'unknown',
        };
    }).filter(Boolean);
}

function findRecentEpisodicMergeTargetInMemory(episodicRowsById, { canonicalKey, vector, timestamp, source, score }) {
    if (!canonicalKey || !isEligibleForEpisodicMerge(canonicalKey, source, score)) {
        return null;
    }

    const recentRows = Array.from(episodicRowsById.values())
        .filter((row) => row && row.timestamp >= (timestamp - EPISODIC_MERGE_WINDOW_MS) && row.timestamp <= timestamp)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, EPISODIC_MERGE_MAX_CANDIDATES);

    let bestCandidate = null;
    for (const row of recentRows) {
        if (!row || !isEligibleForEpisodicMerge(row.text, row.source, row.score)) continue;

        const vectorSimilarity = computeCosineSimilarity(vector, row.vector);
        const tokenOverlap = computeCanonicalTokenOverlap(canonicalKey, row.canonicalKey || '');
        const veryCloseInTime = Math.abs(timestamp - row.timestamp) <= (8 * 60 * 1000);
        const qualifies = vectorSimilarity >= EPISODIC_MERGE_MIN_VECTOR_SIMILARITY
            || tokenOverlap >= EPISODIC_MERGE_MIN_TOKEN_OVERLAP
            || (veryCloseInTime && vectorSimilarity >= 0.48)
            || (veryCloseInTime && tokenOverlap >= 0.08);

        if (!qualifies) continue;

        const agePenalty = Math.max(0, timestamp - row.timestamp) / EPISODIC_MERGE_WINDOW_MS;
        const combinedScore = (vectorSimilarity * 0.75) + (tokenOverlap * 0.25) - (agePenalty * 0.1);
        if (!bestCandidate || combinedScore > bestCandidate.combinedScore) {
            bestCandidate = { row, combinedScore };
        }
    }

    return bestCandidate?.row || null;
}

function applyRebuildVectorWrites(pendingWrites) {
    if (!db) throw new Error('[RAG] Database not initialized');
    const rows = Array.from(pendingWrites.values()).sort((a, b) => a.timestamp - b.timestamp);
    const upsertStmt = db.prepare(
        'INSERT OR REPLACE INTO vectors (id, message_id, text, vector, timestamp, tier, source, score, canonical_key, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    const applyWrites = db.transaction((items) => {
        const deletedCount = deleteMessageVectorsOnly();
        for (const item of items) {
            const vectorBuf = Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength);
            upsertStmt.run(
                item.id,
                item.messageId || null,
                item.text,
                vectorBuf,
                item.timestamp,
                normalizeTier(item.tier),
                typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'unknown',
                Number.isFinite(item.score) ? Number(item.score) : 0,
                typeof item.canonicalKey === 'string' && item.canonicalKey.trim() ? item.canonicalKey.trim() : null,
                typeof item.role === 'string' ? item.role : 'unknown'
            );
        }
        return deletedCount;
    });

    const deletedCount = applyWrites(rows);
    return { deletedCount, appliedCount: rows.length };
}

async function runRagRebuildJob(job) {
    const jobStartedAt = Date.now();
    console.log(`[RAG REBUILD] job=${job?.jobId ?? 'unknown'} starting`);
    try {
        const { buildRebuildCandidates } = await loadRebuildCoreModule();
        const rawMessages = getAllRawMessages();
        console.log(`[RAG REBUILD] job=${job?.jobId ?? 'unknown'} loaded rawMessages=${rawMessages.length} elapsedMs=${Date.now() - jobStartedAt}`);
        updateRebuildJobProgress(job, {
            stage: 'loading_source_history',
            processed: rawMessages.length,
            total: rawMessages.length,
            extra: `messages=${rawMessages.length}`,
        }, true);

        updateRebuildJobProgress(job, {
            stage: 'grouping_fragments',
            processed: 0,
            total: rawMessages.length,
        }, true);

        const candidateBuild = buildRebuildCandidates(rawMessages, {
            progressInterval: 20,
            onProgress: ({ processed, total, accepted, filtered, deduped }) => {
                updateRebuildJobProgress(job, {
                    stage: 'grouping_fragments',
                    processed,
                    total,
                    candidateCount: accepted,
                    filteredCount: filtered,
                    duplicateCount: deduped,
                    extra: `accepted=${accepted}, filtered=${filtered}, deduped=${deduped}`,
                });
            },
        });

        const rebuildCandidates = candidateBuild.candidates;
        updateRebuildJobProgress(job, {
            stage: 'grouping_fragments',
            processed: candidateBuild.validMessageCount,
            total: candidateBuild.validMessageCount,
            candidateCount: rebuildCandidates.length,
            filteredCount: candidateBuild.filteredCount,
            duplicateCount: candidateBuild.duplicateCount,
            groupedCount: candidateBuild.groupedCount,
            extra: `accepted=${rebuildCandidates.length}, filtered=${candidateBuild.filteredCount}, deduped=${candidateBuild.duplicateCount}`,
        }, true);

        const canonicalRowsByKey = new Map();
        getRebuildBaseCanonicalRows().forEach((row) => upsertCanonicalRowInIndex(canonicalRowsByKey, row));
        const episodicRowsById = new Map();
        getRebuildBaseEpisodicRows().forEach((row) => episodicRowsById.set(row.id, row));
        const pendingWrites = new Map();
        let storedCount = 0;
        let mergedCount = 0;
        let skippedExistingCount = 0;

        updateRebuildJobProgress(job, {
            stage: 'generating_embeddings',
            processed: 0,
            total: rebuildCandidates.length,
            candidateCount: rebuildCandidates.length,
            filteredCount: candidateBuild.filteredCount,
            duplicateCount: candidateBuild.duplicateCount,
            groupedCount: candidateBuild.groupedCount,
            storedCount,
            mergedCount,
            skippedExistingCount,
            extra: `accepted=${rebuildCandidates.length}`,
        }, true);

        const REBUILD_YIELD_INTERVAL = 4;
        const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

        for (let index = 0; index < rebuildCandidates.length; index += 1) {
            if (index > 0 && index % REBUILD_YIELD_INTERVAL === 0) {
                await yieldToEventLoop();
            }

            const candidate = rebuildCandidates[index];
            const normalizedTier = normalizeTier(candidate.memoryDecision.tier);
            const normalizedSource = candidate.grouped ? 'rebuild_fragment' : 'rebuild_message';
            const normalizedScore = Number.isFinite(candidate.memoryDecision.score) ? Number(candidate.memoryDecision.score) : 0;
            const normalizedTimestamp = Number.isFinite(candidate.timestamp) ? Number(candidate.timestamp) : Date.now();
            const normalizedRole = inferRoleScopeFromText(candidate.ragEntry, candidate.role);
            const resolvedCanonicalKey = candidate.memoryDecision.canonicalKey || createCanonicalKeyFromRawText(candidate.ragEntry) || null;

            if (shouldSkipCanonicalDuplicateFromIndex(canonicalRowsByKey, resolvedCanonicalKey, normalizedTier, normalizedSource)) {
                skippedExistingCount += 1;
                updateRebuildJobProgress(job, {
                    stage: 'generating_embeddings',
                    processed: index + 1,
                    total: rebuildCandidates.length,
                    storedCount,
                    mergedCount,
                    skippedExistingCount,
                    extra: `inserted=${storedCount}, merged=${mergedCount}, skipped_existing=${skippedExistingCount}`,
                });
                continue;
            }

            const vector = await generateEmbeddingInWorker(candidate.ragEntry);
            if (normalizedTier === RAG_TIER_EPISODIC) {
                const mergeTarget = findRecentEpisodicMergeTargetInMemory(episodicRowsById, {
                    canonicalKey: resolvedCanonicalKey || createCanonicalKeyFromRawText(candidate.ragEntry),
                    vector,
                    timestamp: normalizedTimestamp,
                    source: normalizedSource,
                    score: normalizedScore,
                });

                if (mergeTarget) {
                    const mergedText = buildMergedEpisodicText(mergeTarget.text, candidate.ragEntry);
                    const mergedCanonicalKey = createCanonicalKeyFromRawText(mergedText);
                    const mergedVector = await generateEmbeddingInWorker(mergedText);
                    const previousCanonicalKey = mergeTarget.canonicalKey;
                    removeCanonicalRowFromIndex(canonicalRowsByKey, {
                        id: mergeTarget.id,
                        canonicalKey: previousCanonicalKey,
                    });

                    mergeTarget.messageId = null;
                    mergeTarget.text = mergedText;
                    mergeTarget.vector = mergedVector;
                    mergeTarget.timestamp = normalizedTimestamp;
                    mergeTarget.tier = RAG_TIER_EPISODIC;
                    mergeTarget.source = 'episodic_merge';
                    mergeTarget.score = Math.min(
                        Math.max(Number(mergeTarget.score) || 0, normalizedScore) + 0.5,
                        5.8
                    );
                    mergeTarget.canonicalKey = mergedCanonicalKey || null;
                    mergeTarget.role = inferRoleScopeFromText(mergedText, mergeTarget.role || normalizedRole);

                    upsertCanonicalRowInIndex(canonicalRowsByKey, mergeTarget);
                    episodicRowsById.set(mergeTarget.id, mergeTarget);
                    pendingWrites.set(mergeTarget.id, mergeTarget);
                    mergedCount += 1;

                    updateRebuildJobProgress(job, {
                        stage: 'generating_embeddings',
                        processed: index + 1,
                        total: rebuildCandidates.length,
                        storedCount,
                        mergedCount,
                        skippedExistingCount,
                        extra: `inserted=${storedCount}, merged=${mergedCount}, skipped_existing=${skippedExistingCount}`,
                    });
                    continue;
                }
            }

            const nextRow = {
                id: createRagVectorId(),
                messageId: candidate.messageId || null,
                text: candidate.ragEntry,
                vector,
                timestamp: normalizedTimestamp,
                tier: normalizedTier,
                source: normalizedSource,
                score: normalizedScore,
                canonicalKey: resolvedCanonicalKey,
                role: normalizedRole,
            };
            pendingWrites.set(nextRow.id, nextRow);
            upsertCanonicalRowInIndex(canonicalRowsByKey, nextRow);
            if (normalizedTier === RAG_TIER_EPISODIC) {
                episodicRowsById.set(nextRow.id, nextRow);
            }
            storedCount += 1;

            updateRebuildJobProgress(job, {
                stage: 'generating_embeddings',
                processed: index + 1,
                total: rebuildCandidates.length,
                storedCount,
                mergedCount,
                skippedExistingCount,
                extra: `inserted=${storedCount}, merged=${mergedCount}, skipped_existing=${skippedExistingCount}`,
            });
        }

        // --- PHASE: Official Lore ---
        if (loreChunks.length > 0) {
            updateRebuildJobProgress(job, {
                stage: 'indexing_lore',
                processed: 0,
                total: loreChunks.length,
                extra: `lore_chunks=${loreChunks.length}`,
            }, true);

            let loreIndexed = 0;
            for (let i = 0; i < loreChunks.length; i++) {
                if (i > 0 && i % REBUILD_YIELD_INTERVAL === 0) {
                    await yieldToEventLoop();
                }

                const chunk = loreChunks[i];
                const text = chunk.content;
                if (!text || text.trim().length < 10) continue;

                try {
                    const loreId = chunk.id || `lore-${createRagVectorId()}`;
                    const canonicalKey = createCanonicalKeyFromRawText(text);

                    if (shouldSkipCanonicalDuplicateFromIndex(canonicalRowsByKey, canonicalKey, RAG_TIER_CORE, 'official_lore')) {
                        updateRebuildJobProgress(job, {
                            stage: 'indexing_lore',
                            processed: i + 1,
                            total: loreChunks.length,
                            extra: `lore_indexed=${loreIndexed}/${loreChunks.length}`,
                        });
                        continue;
                    }

                    const vector = await generateEmbeddingInWorker(text);
                    const loreRow = {
                        id: loreId,
                        messageId: null,
                        text,
                        vector,
                        timestamp: Date.now(),
                        tier: RAG_TIER_CORE,
                        source: 'official_lore',
                        score: 0,
                        canonicalKey,
                        role: 'unknown',
                    };

                    pendingWrites.set(loreRow.id, loreRow);
                    upsertCanonicalRowInIndex(canonicalRowsByKey, loreRow);
                    loreIndexed++;
                    storedCount++;

                    updateRebuildJobProgress(job, {
                        stage: 'indexing_lore',
                        processed: i + 1,
                        total: loreChunks.length,
                        storedCount,
                        extra: `lore_indexed=${loreIndexed}/${loreChunks.length}`,
                    });
                } catch (err) {
                    console.warn(`[RAG] Failed to index lore chunk ${chunk.id}:`, err.message);
                }
            }
            console.log(`[RAG Rebuild] Lore indexing complete: ${loreIndexed}/${loreChunks.length} chunks indexed.`);
        }

        updateRebuildJobProgress(job, {
            stage: 'writing_sqlite_rows',
            processed: rebuildCandidates.length,
            total: rebuildCandidates.length,
            storedCount,
            mergedCount,
            skippedExistingCount,
            extra: `writes=${pendingWrites.size}, inserted=${storedCount}, merged=${mergedCount}`,
        }, true);

        const { deletedCount, appliedCount } = applyRebuildVectorWrites(pendingWrites);
        updateRebuildJobProgress(job, {
            stage: 'building_indexes',
            processed: appliedCount,
            total: appliedCount || rebuildCandidates.length,
            storedCount,
            mergedCount,
            skippedExistingCount,
            clearedCount: deletedCount,
            extra: `cleared=${deletedCount}, writes=${appliedCount}`,
        }, true);

        await rebuildHnswFromSqlite();

        const finalStats = getVectorStats();
        job.finalStats = finalStats;
        job.storedCount = storedCount;
        job.mergedCount = mergedCount;
        job.skippedExistingCount = skippedExistingCount;
        job.clearedCount = deletedCount;
        updateRebuildJobProgress(job, {
            stage: 'finalizing_statistics',
            processed: finalStats.vectorCount,
            total: finalStats.vectorCount || 0,
            finalStats,
            extra: `core=${finalStats.coreCount}, episodic=${finalStats.episodicCount}, background=${finalStats.backgroundCount}`,
        }, true);

        console.log('[RAG REBUILD] completed:', {
            accepted: rebuildCandidates.length,
            filtered: candidateBuild.filteredCount,
            deduped: candidateBuild.duplicateCount,
            inserted: storedCount,
            merged: mergedCount,
            skippedExisting: skippedExistingCount,
            cleared: deletedCount,
            finalVectors: finalStats.vectorCount,
            core: finalStats.coreCount,
            episodic: finalStats.episodicCount,
            background: finalStats.backgroundCount,
        });

        finishRebuildJob(job, 'rag:rebuild:done', {
            stage: 'finalizing_statistics',
            processed: finalStats.vectorCount,
            total: finalStats.vectorCount || 0,
            finalStats,
            appliedCount,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[RAG REBUILD] job=${job?.jobId ?? 'unknown'} failed elapsedMs=${Date.now() - jobStartedAt} stage=${job?.stage ?? 'unknown'} error=${message}`, error);
        finishRebuildJob(job, 'rag:rebuild:error', {
            error: message,
        });
    }
}

// ==========================================
// 7. IPC HANDLERS
// ==========================================
function registerIpcHandlers() {
    ipcMain.handle('rag:embed', async (event, text) => {
        try {
            const vector = await generateEmbedding(text);
            return { success: true, vector: Array.from(vector) };
        } catch (e) {
            console.error('[RAG IPC] embed failed:', e);
            return { success: false, error: e.message };
        }
    });
    
    ipcMain.handle('rag:save', async (event, payload) => {
        try {
            const { id: providedId, text, messageId, tier, source, score, canonicalKey, timestamp, role } = payload || {};
            const normalizedTier = normalizeTier(tier);
            const normalizedSource = typeof source === 'string' && source.trim() ? source.trim() : 'unknown';
            const normalizedScore = Number.isFinite(score) ? Number(score) : 0;
            const normalizedCanonicalKey = typeof canonicalKey === 'string' && canonicalKey.trim()
                ? canonicalKey.trim()
                : null;
            const normalizedTimestamp = Number.isFinite(timestamp) ? Number(timestamp) : Date.now();
            const normalizedRole = inferRoleScopeFromText(text, role);
            const normalizedId = typeof providedId === 'string' && providedId.trim()
                ? providedId.trim()
                : createRagVectorId();
            const existingRow = db.prepare('SELECT id, tier FROM vectors WHERE id = ?').get(normalizedId);

            if (shouldSkipCanonicalDuplicate(normalizedCanonicalKey, normalizedTier, normalizedSource, normalizedId)) {
                return { success: true, skipped: true, reason: 'canonical_duplicate' };
            }

            const vector = await generateEmbedding(text);
            if (normalizedTier === RAG_TIER_EPISODIC) {
                const mergeTarget = findRecentEpisodicMergeTarget({
                    canonicalKey: normalizedCanonicalKey || createCanonicalKeyFromRawText(text),
                    vector,
                    timestamp: normalizedTimestamp,
                    source: normalizedSource,
                    score: normalizedScore,
                });

                if (mergeTarget) {
                    const mergedText = buildMergedEpisodicText(mergeTarget.text, text);
                    const mergedCanonicalKey = createCanonicalKeyFromRawText(mergedText);
                    const mergedVector = await generateEmbedding(mergedText);
                    const mergedRole = inferRoleScopeFromText(mergedText, mergeTarget.role || normalizedRole);
                    const mergedScore = Math.min(
                        Math.max(Number(mergeTarget.score) || 0, normalizedScore) + 0.5,
                        5.8
                    );

                    const mergedVectorBuf = Buffer.from(mergedVector.buffer);
                    db.prepare(
                        `UPDATE vectors
                         SET message_id = ?, text = ?, vector = ?, timestamp = ?, tier = ?, source = ?, score = ?, canonical_key = ?, role = ?
                         WHERE id = ?`
                    ).run(
                        null,
                        mergedText,
                        mergedVectorBuf,
                        normalizedTimestamp,
                        RAG_TIER_EPISODIC,
                        'episodic_merge',
                        mergedScore,
                        mergedCanonicalKey || null,
                        mergedRole,
                        mergeTarget.id
                    );

                    replaceInHnswIndex(mergeTarget.id, mergedVector, RAG_TIER_EPISODIC);
                    console.log(`[RAG] Merged episodic fragment into existing memory ${mergeTarget.id}.`);
                    return { success: true, merged: true, id: mergeTarget.id };
                }
            }

            // Save to SQLite
            const vectorBuf = Buffer.from(vector.buffer);
            db.prepare(
                'INSERT OR REPLACE INTO vectors (id, message_id, text, vector, timestamp, tier, source, score, canonical_key, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(normalizedId, messageId || null, text, vectorBuf, normalizedTimestamp, normalizedTier, normalizedSource, normalizedScore, normalizedCanonicalKey, normalizedRole);
            
            // Add to HNSW index
            if (existingRow) {
                const existingTier = normalizeTier(existingRow.tier);
                if (existingTier === normalizedTier) {
                    replaceInHnswIndex(normalizedId, vector, normalizedTier);
                } else {
                    removeFromHnswIndex(normalizedId, existingTier);
                    addToHnswIndex(normalizedId, vector, normalizedTier);
                }
            } else {
                addToHnswIndex(normalizedId, vector, normalizedTier);
            }
            
            console.log(`[RAG] Saved ${normalizedTier} vector: "${text.substring(0, 50)}..."`);
            return { success: true, id: normalizedId };
        } catch (e) {
            console.error('[RAG IPC] save failed:', e);
            return { success: false, error: e.message };
        }
    });
    
    ipcMain.handle('rag:search', async (event, { query, topK, startTime, endTime, role, memoryIntent, keywords }) => {
        try {
            const results = await searchVectors(query, topK || 5, { startTime, endTime, role }, memoryIntent || 'default', keywords);
            return { success: true, results };
        } catch (e) {
            console.error('[RAG IPC] search failed:', e);
            return { success: false, error: e.message, results: [] };
        }
    });
    
    ipcMain.handle('rag:expand-context', async (event, { timestamp }) => {
        try {
            if (!Number.isFinite(timestamp)) {
                return { success: false, error: 'Invalid timestamp' };
            }

            const messageResults = getRawMessageContextWindow(timestamp, 5);
            if (messageResults.length > 0) {
                return {
                    success: true,
                    messages: messageResults,
                };
            }

            const beforeRows = db.prepare(
                'SELECT message_id, text, timestamp, role FROM vectors WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 5'
            ).all(timestamp);

            const targetRow = db.prepare(
                'SELECT message_id, text, timestamp, role FROM vectors WHERE timestamp = ? LIMIT 1'
            ).get(timestamp);

            const afterRows = db.prepare(
                'SELECT message_id, text, timestamp, role FROM vectors WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 5'
            ).all(timestamp);

            const results = [
                ...beforeRows.reverse(),
                ...(targetRow ? [targetRow] : []),
                ...afterRows
            ];
            
            return {
                success: true,
                messages: results.map(row => ({
                    messageId: row.message_id,
                    text: row.text,
                    timestamp: row.timestamp,
                    role: row.role
                }))
            };
        } catch (e) {
            console.error('[RAG IPC] expand-context failed:', e);
            return { success: false, messages: [], error: e.message };
        }
    });

    ipcMain.handle('rag:sync-messages', async (event, payload) => {
        try {
            const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
            const items = rawMessages.map(normalizeRawMessageRecord).filter(Boolean);
            const replaceAll = !!payload?.replaceAll;
            const droppedCount = rawMessages.length - items.length;
            if (droppedCount > 0) {
                console.warn('[RAG IPC] sync-messages dropped invalid raw messages.', {
                    received: rawMessages.length,
                    accepted: items.length,
                    droppedCount,
                    replaceAll,
                });
            }
            upsertRawMessages(items, replaceAll);
            return { success: true, count: items.length };
        } catch (e) {
            console.error('[RAG IPC] sync-messages failed:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('rag:get-messages', async () => {
        try {
            return {
                success: true,
                messages: getAllRawMessages(),
            };
        } catch (e) {
            console.error('[RAG IPC] get-messages failed:', e);
            return { success: false, messages: [], error: e.message };
        }
    });
    
    ipcMain.handle('rag:get-all', async () => {
        try {
            const rows = db.prepare(
                'SELECT id, message_id, text, vector, timestamp, tier, source, score, canonical_key, role FROM vectors'
            ).all();
            return {
                success: true,
                vectors: rows.map(row => ({
                    id: row.id,
                    messageId: row.message_id,
                    text: row.text,
                    vector: Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)),
                    timestamp: row.timestamp,
                    tier: normalizeTier(row.tier),
                    source: row.source || undefined,
                    score: Number.isFinite(row.score) ? row.score : 0,
                    canonicalKey: row.canonical_key || undefined,
                    role: row.role || 'unknown',
                }))
            };
        } catch (e) {
            console.error('[RAG IPC] get-all failed:', e);
            return { success: false, vectors: [] };
        }
    });
    
    ipcMain.handle('rag:restore', async (event, vectors) => {
        try {
            if (!Array.isArray(vectors)) return { success: false, error: 'Invalid data' };
            
            const stmt = db.prepare(
                'INSERT OR REPLACE INTO vectors (id, message_id, text, vector, timestamp, tier, source, score, canonical_key, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            
            const insertMany = db.transaction((items) => {
                db.exec('DELETE FROM vectors');
                for (const item of items) {
                    const vectorBuf = Buffer.from(new Float32Array(item.vector).buffer);
                    stmt.run(
                        item.id,
                        item.messageId || null,
                        item.text,
                        vectorBuf,
                        item.timestamp,
                        normalizeTier(item.tier),
                        typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'unknown',
                        Number.isFinite(item.score) ? Number(item.score) : 0,
                        typeof item.canonicalKey === 'string' && item.canonicalKey.trim() ? item.canonicalKey.trim() : null,
                        typeof item.role === 'string' ? item.role : 'unknown'
                    );
                }
            });
            
            insertMany(vectors);
            
            await rebuildHnswFromSqlite();
            
            console.log(`[RAG] Restored ${vectors.length} vectors + rebuilt HNSW index.`);
            return { success: true, count: vectors.length };
        } catch (e) {
            console.error('[RAG IPC] restore failed:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('rag:clear-all', async () => {
        try {
            clearAllVectors();
            return { success: true };
        } catch (e) {
            console.error('[RAG IPC] clear-all failed:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('rag:clear-message-vectors', async () => {
        try {
            const count = await clearMessageVectors();
            return { success: true, count };
        } catch (e) {
            console.error('[RAG IPC] clear-message-vectors failed:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('rag:rebuild:start', async (event) => {
        try {
            if (activeRebuildJob) {
                return {
                    success: true,
                    started: false,
                    alreadyRunning: true,
                    snapshot: buildRebuildJobPayload(activeRebuildJob),
                };
            }

            const job = createRebuildJob(event.sender);
            activeRebuildJob = job;
            const snapshot = buildRebuildJobPayload(job);
            safeSendRebuildEvent(job, 'rag:rebuild:started', snapshot);
            void runRagRebuildJob(job);
            return {
                success: true,
                started: true,
                alreadyRunning: false,
                snapshot,
            };
        } catch (e) {
            console.error('[RAG IPC] rebuild-start failed:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('rag:rebuild:status', async () => {
        return {
            success: true,
            active: !!activeRebuildJob,
            snapshot: activeRebuildJob ? buildRebuildJobPayload(activeRebuildJob) : null,
        };
    });

    ipcMain.handle('rag:stats', async () => {
        try {
            return {
                success: true,
                stats: getVectorStats(),
            };
        } catch (e) {
            console.error('[RAG IPC] stats failed:', e);
            return { success: false, error: e.message };
        }
    });
    
    ipcMain.handle('rag:status', async () => {
        const stats = getVectorStats();
        return {
            modelLoaded: isModelLoaded,
            modelLoading: !!modelLoadPromise,
            modelBackend: activeModelBackend,
            modelError: modelLoadError,
            workerModelLoaded: ragWorkerModelLoaded,
            workerLoading: !!ragWorkerLoadPromise,
            vectorCount: stats.vectorCount,
            coreCount: stats.coreCount,
            episodicCount: stats.episodicCount,
            backgroundCount: stats.backgroundCount,
            messageLinkedCount: stats.messageLinkedCount,
            hnswIndexed: stats.hnswIndexed,
            coreIndexed: stats.coreIndexed,
            episodicIndexed: stats.episodicIndexed,
            backgroundIndexed: stats.backgroundIndexed,
            messageCount: stats.messageCount,
            rebuildRunning: !!activeRebuildJob,
            rebuildJob: activeRebuildJob ? buildRebuildJobPayload(activeRebuildJob) : null,
            dbPath: getDbPath()
        };
    });
    
    console.log('[RAG] IPC handlers registered.');
}

// ==========================================
// 8. INIT & EXPORT
// ==========================================
async function initRag() {
    try {
        initDatabase();
        initHnswIndexes();
        await rebuildHnswFromSqlite();
        registerIpcHandlers();
        
        // Load model asynchronously (don't block app startup)
        loadModel().then(success => {
            if (success) {
                console.log('[RAG] ✅ Full RAG system ready (SQLite + HNSW + bge-m3 ONNX).');
            } else {
                console.warn('[RAG] ⚠️ Model loading failed. Semantic embedding and hybrid recall will stay degraded until the local model is available.');
            }
        });
    } catch (e) {
        console.error('[RAG] Failed to initialize RAG system:', e);
    }
}

// v2.14.28 M7: closeRag is now async so the caller (electron-main.cjs
// will-quit) can await the worker termination. Previously the
// `void ragWorker.terminate()` was fire-and-forget and Electron's
// will-quit could finish before the worker's `process.exit(0)` finished
// flushing — usually fine, but on slow machines the worker process
// stuck around for a few hundred ms after the renderer exited, and a
// subsequent install/upgrade saw the .so file locked. Awaiting closes
// the gap.
async function closeRag() {
    if (db) {
        db.close();
        db = null;
        console.log('[RAG] Database closed.');
    }
    if (activeRebuildJob) {
        clearRebuildProgressTimer(activeRebuildJob);
        activeRebuildJob = null;
    }
    if (ragWorker) {
        try {
            await ragWorker.terminate();
        } catch (e) {
            console.warn('[RAG] worker.terminate() rejected:', e?.message || e);
        }
        ragWorker = null;
    }
    isModelLoaded = false;
    modelLoadError = null;
    modelLoadPromise = null;
    activeModelBackend = 'none';
    mainProcessOrt = null;
    mainProcessSession = null;
    mainProcessTokenizer = null;
    ragWorkerModelLoaded = false;
    ragWorkerLoadPromise = null;
    rebuildCoreModulePromise = null;
    embeddingBackendLoggedForSession = false;
    workerCallbacks.clear();
    hnswStates = {
        [RAG_TIER_CORE]: createHnswState(),
        [RAG_TIER_EPISODIC]: createHnswState(),
        [RAG_TIER_BACKGROUND]: createHnswState(),
    };
}

module.exports = { initRag, closeRag };
