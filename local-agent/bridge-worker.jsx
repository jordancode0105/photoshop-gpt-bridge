/* Photoshop GPT Bridge - ExtendScript worker */
(function () {
    function quoteString(value) {
        return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
    }
    function stringify(value) {
        if (value === null || typeof value === "undefined") return "null";
        var type = typeof value;
        if (type === "string") return quoteString(value);
        if (type === "number") return isFinite(value) ? String(value) : "null";
        if (type === "boolean") return value ? "true" : "false";
        var i, parts = [];
        if (value instanceof Array) {
            for (i = 0; i < value.length; i++) parts.push(stringify(value[i]));
            return "[" + parts.join(",") + "]";
        }
        for (var key in value) {
            if (value.hasOwnProperty(key) && typeof value[key] !== "function") parts.push(quoteString(key) + ":" + stringify(value[key]));
        }
        return "{" + parts.join(",") + "}";
    }
    function readUtf8(path) {
        var file = new File(path); file.encoding = "UTF8";
        if (!file.open("r")) throw new Error("Could not open input file: " + path);
        var text = file.read(); file.close();
        if (text.length && text.charCodeAt(0) === 65279) text = text.substring(1);
        return text;
    }
    function writeUtf8(path, value) {
        var file = new File(path); file.encoding = "UTF8";
        if (!file.open("w")) throw new Error("Could not open output file: " + path);
        file.write(value); file.close();
    }
    function parseJson(text) {
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
        return eval("(" + text + ")");
    }
    function toPixels(value) {
        if (value === null || typeof value === "undefined") return null;
        try { if (value.as) return Number(value.as("px")); } catch (_error) {}
        var n = Number(value); return isNaN(n) ? null : n;
    }
    function safeLayerId(layer) { try { return Number(layer.id); } catch (_error) { return null; } }
    function safeLayerKind(layer) {
        if (layer.typename === "LayerSet") return "group";
        try { return String(layer.kind); } catch (_error) { return layer.typename; }
    }
    function isSmartObject(layer) {
        try { return layer.typename === "ArtLayer" && layer.kind === LayerKind.SMARTOBJECT; } catch (_error) { return false; }
    }
    function safeBounds(layer) {
        try {
            var b = layer.bounds;
            return { left: toPixels(b[0]), top: toPixels(b[1]), right: toPixels(b[2]), bottom: toPixels(b[3]) };
        } catch (_error) { return null; }
    }
    function serializeLayer(layer, parentNames, indexPath) {
        var names = parentNames.slice(0); names.push(layer.name);
        var item = {
            id: safeLayerId(layer), name: layer.name, path: names.join(" / "), indexPath: indexPath.slice(0),
            typename: layer.typename, kind: safeLayerKind(layer), isSmartObject: isSmartObject(layer),
            isGroup: layer.typename === "LayerSet", visible: Boolean(layer.visible), opacity: Number(layer.opacity),
            bounds: safeBounds(layer), children: []
        };
        if (layer.typename === "LayerSet") {
            for (var i = 0; i < layer.layers.length; i++) {
                var childPath = indexPath.slice(0); childPath.push(i);
                item.children.push(serializeLayer(layer.layers[i], names, childPath));
            }
        }
        return item;
    }
    function getDocument(documentName) {
        if (app.documents.length === 0) throw new Error("No Photoshop document is open.");
        if (!documentName) return app.activeDocument;
        for (var i = 0; i < app.documents.length; i++) if (app.documents[i].name === documentName) return app.documents[i];
        throw new Error("Open document not found: " + documentName);
    }
    function inspectDocument(payload) {
        var doc = getDocument(payload.documentName); app.activeDocument = doc;
        var tree = [];
        for (var i = 0; i < doc.layers.length; i++) tree.push(serializeLayer(doc.layers[i], [], [i]));
        var fullPath = null; try { fullPath = doc.fullName.fsName; } catch (_error) {}
        return {
            document: { name: doc.name, width: toPixels(doc.width), height: toPixels(doc.height), resolution: Number(doc.resolution), saved: Boolean(doc.saved), path: fullPath },
            layers: tree,
            guidance: "Use a numeric layer ID when available. Duplicate names are rejected for write operations."
        };
    }
    function findLayerRecursive(layers, predicate, parentPath, matches) {
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i], indexPath = parentPath.slice(0); indexPath.push(i);
            if (predicate(layer)) matches.push({ layer: layer, indexPath: indexPath });
            if (layer.typename === "LayerSet") findLayerRecursive(layer.layers, predicate, indexPath, matches);
        }
    }
    function resolveSourceTarget(doc, payload) {
        var matches = [];
        if (payload.layerId) {
            var wantedId = Number(payload.layerId);
            findLayerRecursive(doc.layers, function (layer) { return safeLayerId(layer) === wantedId; }, [], matches);
            if (matches.length !== 1) throw new Error("Layer ID " + wantedId + " was not found uniquely.");
            return matches[0];
        }
        if (!payload.layerName) throw new Error("A layerId or layerName is required.");
        var wantedName = String(payload.layerName);
        findLayerRecursive(doc.layers, function (layer) { return layer.name === wantedName; }, [], matches);
        if (matches.length === 0) throw new Error('Layer not found: "' + wantedName + '".');
        if (matches.length > 1) throw new Error('Multiple layers are named "' + wantedName + '". Inspect and use layerId.');
        return matches[0];
    }
    function getLayerByIndexPath(doc, path) {
        var collection = doc.layers, layer = null;
        for (var i = 0; i < path.length; i++) {
            var index = Number(path[i]);
            if (index < 0 || index >= collection.length) throw new Error("The target layer path changed while duplicating the document.");
            layer = collection[index];
            if (i < path.length - 1) {
                if (layer.typename !== "LayerSet") throw new Error("The target layer group path is no longer valid.");
                collection = layer.layers;
            }
        }
        return layer;
    }
    function rect(bounds) {
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom,
            width: bounds.right - bounds.left, height: bounds.bottom - bounds.top,
            centerX: (bounds.left + bounds.right) / 2, centerY: (bounds.top + bounds.bottom) / 2 };
    }
    function replaceSelectedSmartObject(file) {
        var descriptor = new ActionDescriptor();
        descriptor.putPath(charIDToTypeID("null"), file);
        executeAction(stringIDToTypeID("placedLayerReplaceContents"), descriptor, DialogModes.NO);
    }
    function blendModeToTypeId(blendMode) {
        switch (String(blendMode).toLowerCase()) {
            case "normal": return charIDToTypeID("Nrml");
            case "color": return charIDToTypeID("Clr ");
            case "multiply": return charIDToTypeID("Mltp");
            case "overlay": return charIDToTypeID("Ovrl");
            case "screen": return charIDToTypeID("Scrn");
        }
        throw new Error("Unsupported Color Overlay blend mode: " + blendMode);
    }
    function layerPathAtIndexPath(doc, indexPath) {
        var names = [], collection = doc.layers;
        for (var i = 0; i < indexPath.length; i++) {
            var layer = collection[Number(indexPath[i])];
            names.push(layer.name);
            if (i < indexPath.length - 1) collection = layer.layers;
        }
        return names.join(" / ");
    }
    function readPreservableLayerEffects() {
        var layerEffectsId = stringIDToTypeID("layerEffects");
        var solidFillMultiId = stringIDToTypeID("solidFillMulti");
        var reference = new ActionReference();
        reference.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));

        var layerDescriptor;
        try {
            layerDescriptor = executeActionGet(reference);
        } catch (error) {
            throw new Error("Could not inspect existing layer effects safely: " + error.message);
        }

        var effectsDescriptor = layerDescriptor.hasKey(layerEffectsId)
            ? layerDescriptor.getObjectValue(layerEffectsId)
            : new ActionDescriptor();
        if (effectsDescriptor.hasKey(solidFillMultiId)) {
            throw new Error("This layer uses multiple Color Overlay effects, which cannot be safely preserved by this operation.");
        }
        return effectsDescriptor;
    }
    function applyColorOverlayToActiveLayer(color, opacity, blendMode, effectsDescriptor) {
        var scaleId = stringIDToTypeID("scale");
        if (!effectsDescriptor.hasKey(scaleId)) {
            effectsDescriptor.putUnitDouble(scaleId, charIDToTypeID("#Prc"), 100.0);
        }

        var solidFillDescriptor = new ActionDescriptor();
        solidFillDescriptor.putBoolean(charIDToTypeID("enab"), true);
        solidFillDescriptor.putBoolean(stringIDToTypeID("present"), true);
        solidFillDescriptor.putBoolean(stringIDToTypeID("showInDialog"), true);
        solidFillDescriptor.putEnumerated(
            charIDToTypeID("Md  "),
            charIDToTypeID("BlnM"),
            blendModeToTypeId(blendMode)
        );
        solidFillDescriptor.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), Number(opacity));

        var colorDescriptor = new ActionDescriptor();
        colorDescriptor.putDouble(charIDToTypeID("Rd  "), Number(color.red));
        colorDescriptor.putDouble(charIDToTypeID("Grn "), Number(color.green));
        colorDescriptor.putDouble(charIDToTypeID("Bl  "), Number(color.blue));
        solidFillDescriptor.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), colorDescriptor);
        effectsDescriptor.putObject(stringIDToTypeID("solidFill"), stringIDToTypeID("solidFill"), solidFillDescriptor);

        var setDescriptor = new ActionDescriptor();
        var reference = new ActionReference();
        reference.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("layerEffects"));
        reference.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        setDescriptor.putReference(charIDToTypeID("null"), reference);
        setDescriptor.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), effectsDescriptor);
        executeAction(charIDToTypeID("setd"), setDescriptor, DialogModes.NO);
    }
    function validateRecolorEdit(edit, seenIds) {
        if (!edit) throw new Error("Every recolor edit must be an object.");
        var layerId = Number(edit.layerId);
        if (!isFinite(layerId) || layerId <= 0 || Math.floor(layerId) !== layerId) throw new Error("Every recolor layerId must be a positive integer.");
        if (seenIds[String(layerId)]) throw new Error("Duplicate recolor layerId: " + layerId);
        seenIds[String(layerId)] = true;

        var color = edit.color || {};
        var channels = ["red", "green", "blue"];
        for (var i = 0; i < channels.length; i++) {
            var value = Number(color[channels[i]]);
            if (!isFinite(value) || value < 0 || value > 255 || Math.floor(value) !== value) {
                throw new Error("Every recolor RGB value must be an integer from 0 through 255.");
            }
        }
        var opacity = typeof edit.opacity === "undefined" ? 100 : Number(edit.opacity);
        if (!isFinite(opacity) || opacity < 0 || opacity > 100) throw new Error("Recolor opacity must be from 0 through 100.");
        var blendMode = typeof edit.blendMode === "undefined" ? "normal" : String(edit.blendMode).toLowerCase();
        blendModeToTypeId(blendMode);
        return {
            layerId: layerId,
            color: { red: Number(color.red), green: Number(color.green), blue: Number(color.blue) },
            opacity: opacity,
            blendMode: blendMode
        };
    }
    function resolveSourceTargetsByEdits(document, edits) {
        var results = [], seenIds = {};
        for (var i = 0; i < edits.length; i++) {
            var validatedEdit = validateRecolorEdit(edits[i], seenIds);
            var matches = [];
            findLayerRecursive(document.layers, function (layer) {
                return safeLayerId(layer) === validatedEdit.layerId;
            }, [], matches);
            if (matches.length !== 1) throw new Error("Layer ID " + validatedEdit.layerId + " was not found uniquely.");
            results.push({
                layer: matches[0].layer,
                indexPath: matches[0].indexPath,
                path: layerPathAtIndexPath(document, matches[0].indexPath),
                edit: validatedEdit
            });
        }
        return results;
    }
    function fitLayer(layer, originalBounds, fitMode) {
        if (fitMode === "keep-transform") return;
        var target = rect(originalBounds), currentBounds = safeBounds(layer);
        if (!currentBounds) throw new Error("Could not read replacement-layer bounds.");
        var current = rect(currentBounds);
        if (target.width <= 0 || target.height <= 0 || current.width <= 0 || current.height <= 0) throw new Error("Cannot fit a Smart Object with empty bounds.");
        var contain = Math.min(target.width / current.width, target.height / current.height);
        var cover = Math.max(target.width / current.width, target.height / current.height);
        var ratio = fitMode === "cover" ? cover : contain;
        layer.resize(ratio * 100, ratio * 100, AnchorPosition.MIDDLECENTER);
        var resized = rect(safeBounds(layer));
        layer.translate(UnitValue(target.centerX - resized.centerX, "px"), UnitValue(target.centerY - resized.centerY, "px"));
    }
    function validatePlainFileName(fileName, extension) {
        if (!fileName || /[\\\/]/.test(fileName)) throw new Error("Only a plain file name is allowed.");
        var lower = String(fileName).toLowerCase();
        if (lower.substring(lower.length - extension.length) !== extension) throw new Error("Expected a " + extension + " file name.");
    }
    function childFile(folder, name) { return new File(folder.fsName + "/" + name); }
    function replaceSmartObject(input) {
        var payload = input.payload || {};
        validatePlainFileName(payload.replacementFileName, ".png");
        validatePlainFileName(payload.outputPsdName, ".psd");
        validatePlainFileName(payload.outputPreviewName, ".png");

        var sourceDoc = getDocument(payload.documentName); app.activeDocument = sourceDoc;
        var sourceTarget = resolveSourceTarget(sourceDoc, payload);
        if (!isSmartObject(sourceTarget.layer)) throw new Error('Target layer "' + sourceTarget.layer.name + '" is not a Smart Object.');
        if (String(payload.outputPsdName).toLowerCase() === sourceDoc.name.toLowerCase()) throw new Error("The output PSD name must not match the original document.");

        var folder = new Folder(input.workingFolder);
        if (!folder.exists) throw new Error("Working folder does not exist: " + input.workingFolder);
        var replacement = childFile(folder, payload.replacementFileName);
        if (!replacement.exists) throw new Error("Replacement file not found in working folder: " + payload.replacementFileName);
        var outputPsd = childFile(folder, payload.outputPsdName);
        var outputPreview = childFile(folder, payload.outputPreviewName);
        if (outputPsd.exists || outputPreview.exists) throw new Error("An output file already exists. Use a new versioned output name.");

        var baseName = payload.outputPsdName.replace(/\.psd$/i, "");
        var workingDoc = sourceDoc.duplicate(baseName, false); app.activeDocument = workingDoc;
        var targetLayer = getLayerByIndexPath(workingDoc, sourceTarget.indexPath);
        if (!isSmartObject(targetLayer)) throw new Error("The duplicated target layer is no longer a Smart Object.");

        var originalBounds = safeBounds(targetLayer);
        if (!originalBounds) throw new Error("Could not read original Smart Object bounds.");
        workingDoc.activeLayer = targetLayer;
        replaceSelectedSmartObject(replacement);
        fitLayer(targetLayer, originalBounds, payload.fitMode || "contain");

        var psdOptions = new PhotoshopSaveOptions();
        psdOptions.layers = true; psdOptions.embedColorProfile = true; psdOptions.alphaChannels = true;
        workingDoc.saveAs(outputPsd, psdOptions, true, Extension.LOWERCASE);

        var previewDoc = workingDoc.duplicate(baseName + "_preview", true); app.activeDocument = previewDoc;
        previewDoc.flatten();
        var pngOptions = new PNGSaveOptions(); pngOptions.interlaced = false;
        previewDoc.saveAs(outputPreview, pngOptions, true, Extension.LOWERCASE);
        previewDoc.close(SaveOptions.DONOTSAVECHANGES); app.activeDocument = workingDoc;

        return {
            originalDocument: sourceDoc.name, outputDocumentOpen: workingDoc.name,
            layerId: safeLayerId(targetLayer), layerName: targetLayer.name,
            replacementFileName: payload.replacementFileName, fitMode: payload.fitMode || "contain",
            outputPsdPath: outputPsd.fsName, outputPreviewPath: outputPreview.fsName, originalPreserved: true
        };
    }
    function recolorLayers(input) {
        var payload = input.payload || {};
        if (!(payload.edits instanceof Array) || payload.edits.length < 1 || payload.edits.length > 25) {
            throw new Error("Recolor edits must contain 1 through 25 entries.");
        }
        validatePlainFileName(payload.outputPsdName, ".psd");
        validatePlainFileName(payload.outputPreviewName, ".png");

        var sourceDocument = getDocument(payload.documentName);
        app.activeDocument = sourceDocument;
        if (String(payload.outputPsdName).toLowerCase() === sourceDocument.name.toLowerCase()) {
            throw new Error("The output PSD name must not match the original document.");
        }

        var workingFolder = new Folder(input.workingFolder);
        if (!workingFolder.exists) throw new Error("Working folder does not exist: " + input.workingFolder);
        var outputPsd = childFile(workingFolder, payload.outputPsdName);
        var outputPreview = childFile(workingFolder, payload.outputPreviewName);
        if (outputPsd.exists || outputPreview.exists) {
            throw new Error("An output file already exists. Use new versioned output names.");
        }

        // Resolve every requested source ID and stable index path before duplicating or editing.
        var sourceTargets = resolveSourceTargetsByEdits(sourceDocument, payload.edits);
        var outputBaseName = payload.outputPsdName.replace(/\.psd$/i, "");
        var workingDocument = null, previewDocument = null;
        try {
            workingDocument = sourceDocument.duplicate(outputBaseName, false);
            app.activeDocument = workingDocument;

            // Resolve and preflight every duplicate target before changing any layer effect.
            var duplicateTargets = [];
            for (var i = 0; i < sourceTargets.length; i++) {
                var duplicateLayer = getLayerByIndexPath(workingDocument, sourceTargets[i].indexPath);
                workingDocument.activeLayer = duplicateLayer;
                duplicateTargets.push({
                    layer: duplicateLayer,
                    effects: readPreservableLayerEffects(),
                    source: sourceTargets[i]
                });
            }

            var recolored = [];
            for (var j = 0; j < duplicateTargets.length; j++) {
                var target = duplicateTargets[j];
                var edit = target.source.edit;
                workingDocument.activeLayer = target.layer;
                try {
                    applyColorOverlayToActiveLayer(edit.color, edit.opacity, edit.blendMode, target.effects);
                } catch (effectError) {
                    throw new Error('Could not safely apply Color Overlay to "' + target.source.path + '": ' + effectError.message);
                }
                recolored.push({
                    id: edit.layerId,
                    duplicatedLayerId: safeLayerId(target.layer),
                    name: target.layer.name,
                    path: target.source.path,
                    color: edit.color,
                    opacity: edit.opacity,
                    blendMode: edit.blendMode
                });
            }

            var psdOptions = new PhotoshopSaveOptions();
            psdOptions.layers = true;
            psdOptions.embedColorProfile = true;
            psdOptions.alphaChannels = true;
            psdOptions.annotations = true;
            psdOptions.spotColors = true;
            workingDocument.saveAs(outputPsd, psdOptions, false, Extension.LOWERCASE);

            previewDocument = workingDocument.duplicate(outputBaseName + "_preview", true);
            app.activeDocument = previewDocument;
            previewDocument.flatten();
            var pngOptions = new PNGSaveOptions();
            pngOptions.interlaced = false;
            previewDocument.saveAs(outputPreview, pngOptions, true, Extension.LOWERCASE);
            previewDocument.close(SaveOptions.DONOTSAVECHANGES);
            previewDocument = null;
            app.activeDocument = workingDocument;

            return {
                originalDocument: sourceDocument.name,
                outputDocumentOpen: workingDocument.name,
                recoloredLayers: recolored,
                outputPsdPath: outputPsd.fsName,
                outputPreviewPath: outputPreview.fsName,
                originalPreserved: true
            };
        } catch (error) {
            if (previewDocument) {
                try { previewDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_previewCloseError) {}
            }
            if (workingDocument) {
                try { workingDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_workingCloseError) {}
            }
            try { app.activeDocument = sourceDocument; } catch (_activateSourceError) {}
            throw error;
        }
    }
    function execute(input) {
    if (input.type === "inspectDocument") {
        return inspectDocument(input.payload || {});
    }
    if (input.type === "replaceSmartObject") {
        return replaceSmartObject(input);
    }
    if (input.type === "recolorLayers") {
        return recolorLayers(input);
    }
    throw new Error("Unsupported operation: " + input.type);
}
    try {
        var input = parseJson(readUtf8(BRIDGE_INPUT_PATH));
        writeUtf8(BRIDGE_OUTPUT_PATH, stringify({ ok: true, result: execute(input) }));
    } catch (error) {
        var message = error && error.message ? error.message : String(error);
        var line = error && error.line ? " (line " + error.line + ")" : "";
        writeUtf8(BRIDGE_OUTPUT_PATH, stringify({ ok: false, error: message + line }));
    }
}());
