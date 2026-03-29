const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { env, AutoTokenizer } = require('@xenova/transformers');

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

let runtimeModulePath = null;
let ortModule = null;

function requireOnnxRuntimeNode() {
    if (runtimeModulePath) {
        const normalizedPath = normalizeFsPath(runtimeModulePath);
        if (fs.existsSync(normalizedPath)) {
            const binDir = path.join(normalizedPath, 'bin', 'napi-v6', process.platform, process.arch);
            prependProcessPath(binDir);
            console.log(`[RAG Worker] Loading onnxruntime-node from: ${normalizedPath}`);
            return require(normalizedPath);
        }
    }
    if (process.resourcesPath) {
        const packagedModulePath = normalizeFsPath(
            path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node')
        );
        if (fs.existsSync(packagedModulePath)) {
            const binDir = path.join(packagedModulePath, 'bin', 'napi-v6', process.platform, process.arch);
            prependProcessPath(binDir);
            console.log(`[RAG Worker] Loading onnxruntime-node from packaged path: ${packagedModulePath}`);
            return require(packagedModulePath);
        }
    }
    return require('onnxruntime-node');
}

// Configure Transformers.js to not use external Hugging Face servers
env.allowRemoteModels = false;
env.backends.onnx.wasm.numThreads = 1;

let onnxSession = null;
let tokenizer = null;
let isModelLoaded = false;
let modelLoadError = null;

async function loadModel(modelDir, nextRuntimeModulePath = null) {
    if (isModelLoaded) return true;
    runtimeModulePath = nextRuntimeModulePath ? normalizeFsPath(nextRuntimeModulePath) : runtimeModulePath;
    
    const modelPath = path.join(modelDir, 'model_int8.onnx');
    const tokenizerPath = path.join(modelDir, 'tokenizer.json');
    
    if (!fs.existsSync(modelPath)) {
        modelLoadError = `Model file not found: ${modelPath}`;
        return false;
    }
    if (!fs.existsSync(tokenizerPath)) {
        modelLoadError = `Tokenizer file not found: ${tokenizerPath}`;
        return false;
    }
    
    try {
        const ort = requireOnnxRuntimeNode();
        ortModule = ort;
        
        onnxSession = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
            enableCpuMemArena: true,
            intraOpNumThreads: 4
        });
        
        env.localModelPath = path.dirname(modelDir);
        const modelName = path.basename(modelDir);
        tokenizer = await AutoTokenizer.from_pretrained(modelName);
        
        isModelLoaded = true;
        modelLoadError = null;
        return true;
    } catch (e) {
        modelLoadError = e.message;
        return false;
    }
}

async function generateEmbedding(text) {
    if (!isModelLoaded || !onnxSession || !tokenizer) {
        throw new Error('Model not loaded. Cannot generate embedding.');
    }
    
    const ort = ortModule || requireOnnxRuntimeNode();
    
    // Transformers.js tokenizer output
    const { input_ids, attention_mask } = await tokenizer(text, { 
        truncation: true, 
        max_length: 512 
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
    
    const inputIdsTensor = new ort.Tensor('int64', inputIdsTensorData, inputIdsDims);
    const attentionMaskTensor = new ort.Tensor('int64', attentionMaskTensorData, attentionMaskDims);
    
    const feeds = {
        input_ids: inputIdsTensor,
        attention_mask: attentionMaskTensor,
    };
    
    const results = await onnxSession.run(feeds);
    
    let embedding;
    if (results.sentence_embedding) {
        embedding = results.sentence_embedding.data;
    } else if (results.last_hidden_state) {
        const hidden = results.last_hidden_state.data;
        const dims = results.last_hidden_state.dims;
        const hiddenDim = dims[2];
        
        embedding = new Float32Array(hiddenDim);
        let validTokens = 0;
        
        for (let i = 0; i < seqLen; i++) {
            if (attentionMaskData[i] === 1) {
                for (let j = 0; j < hiddenDim; j++) {
                    embedding[j] += hidden[i * hiddenDim + j];
                }
                validTokens++;
            }
        }
        
        if (validTokens > 0) {
            for (let j = 0; j < hiddenDim; j++) {
                embedding[j] /= validTokens;
            }
        }
    } else {
        const firstOutput = Object.values(results)[0];
        if (firstOutput) {
            embedding = firstOutput.data;
        } else {
            throw new Error('No valid output from ONNX model');
        }
    }
    
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < embedding.length; i++) embedding[i] /= norm;
    }
    
    return new Float32Array(embedding);
}

parentPort.on('message', async (message) => {
    const { id, action, payload } = message;
    
    try {
        if (action === 'load') {
            const success = await loadModel(payload.modelDir, payload.runtimeModulePath);
            parentPort.postMessage({ id, action, success, error: modelLoadError });
        } 
        else if (action === 'embed') {
            const vector = await generateEmbedding(payload.text);
            parentPort.postMessage({ 
                id, 
                action, 
                success: true, 
                vector: Array.from(vector) 
            });
        }
    } catch (error) {
        parentPort.postMessage({ id, action, success: false, error: error.message });
    }
});
