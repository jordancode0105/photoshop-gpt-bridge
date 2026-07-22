/* Photoshop GPT Bridge - ExtendScript worker */
(function () {
    function quoteString(value) {
        var text = String(value), output = '"';
        for (var i = 0; i < text.length; i++) {
            var character = text.charAt(i), code = text.charCodeAt(i);
            if (character === '"') output += '\\"';
            else if (character === "\\") output += "\\\\";
            else if (character === "\b") output += "\\b";
            else if (character === "\f") output += "\\f";
            else if (character === "\n") output += "\\n";
            else if (character === "\r") output += "\\r";
            else if (character === "\t") output += "\\t";
            else if (code < 32) output += "\\u" + ("000" + code.toString(16)).slice(-4);
            else output += character;
        }
        return output + '"';
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
    function isTextLayer(layer) {
        try { return layer.typename === "ArtLayer" && layer.kind === LayerKind.TEXT; } catch (_error) { return false; }
    }
    function normalizeTextForResult(value) {
        return String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }
    function normalizeTextForPhotoshop(value) {
        return normalizeTextForResult(value).replace(/\n/g, "\r");
    }
    function readTextStyleRangeSummary(layer) {
        var result = {
            available: false,
            textStyleRangeCount: null,
            paragraphStyleRangeCount: null,
            error: null
        };
        var layerId = safeLayerId(layer);
        if (!layerId) {
            result.error = "The text layer has no readable numeric ID.";
            return result;
        }
        try {
            var reference = new ActionReference();
            reference.putIdentifier(charIDToTypeID("Lyr "), layerId);
            var layerDescriptor = executeActionGet(reference);
            var textKeyId = stringIDToTypeID("textKey");
            if (!layerDescriptor.hasKey(textKeyId)) {
                result.error = "Photoshop did not expose a text descriptor for this layer.";
                return result;
            }
            var textDescriptor = layerDescriptor.getObjectValue(textKeyId);
            var textStyleRangeId = stringIDToTypeID("textStyleRange");
            var paragraphStyleRangeId = stringIDToTypeID("paragraphStyleRange");
            if (!textDescriptor.hasKey(textStyleRangeId) || !textDescriptor.hasKey(paragraphStyleRangeId)) {
                result.error = "Photoshop did not expose complete text and paragraph style ranges.";
                return result;
            }
            result.textStyleRangeCount = textDescriptor.getList(textStyleRangeId).count;
            result.paragraphStyleRangeCount = textDescriptor.getList(paragraphStyleRangeId).count;
            result.available = true;
            return result;
        } catch (error) {
            result.error = "Text style ranges could not be inspected safely: " + error.message;
            return result;
        }
    }
    function inspectTextInfo(layer) {
        var info = {
            contents: null,
            textType: null,
            justification: null,
            font: null,
            size: null,
            color: null,
            hasMultipleTextStyleRanges: null,
            hasMultipleParagraphStyleRanges: null,
            safeForContentOnlyReplacement: false,
            unsupportedReason: null
        };
        if (!isTextLayer(layer)) {
            info.unsupportedReason = "Layer is not a Photoshop text layer.";
            return info;
        }

        var textItem = null;
        try { textItem = layer.textItem; } catch (error) {
            info.unsupportedReason = "Photoshop text metadata is unavailable: " + error.message;
            return info;
        }
        try { info.contents = normalizeTextForResult(textItem.contents); } catch (_contentsError) {}
        try { info.textType = String(textItem.kind); } catch (_typeError) {}
        try { info.justification = String(textItem.justification); } catch (_justificationError) {}
        var fullyLocked = false;
        try { fullyLocked = Boolean(layer.allLocked); } catch (_lockError) {}

        var ranges = readTextStyleRangeSummary(layer);
        if (ranges.available) {
            info.hasMultipleTextStyleRanges = ranges.textStyleRangeCount > 1;
            info.hasMultipleParagraphStyleRanges = ranges.paragraphStyleRangeCount > 1;
        }

        var uniformStyles = ranges.available &&
            ranges.textStyleRangeCount === 1 &&
            ranges.paragraphStyleRangeCount === 1;
        if (uniformStyles) {
            try { info.font = { postScriptName: String(textItem.font) }; } catch (_fontError) {}
            try {
                var pointSize = Number(textItem.size.as("pt"));
                if (isFinite(pointSize)) info.size = { value: pointSize, unit: "pt" };
            } catch (_sizeError) {}
            try {
                var rgb = textItem.color.rgb;
                var red = Number(rgb.red), green = Number(rgb.green), blue = Number(rgb.blue);
                if (isFinite(red) && isFinite(green) && isFinite(blue)) {
                    info.color = { red: red, green: green, blue: blue };
                }
            } catch (_colorError) {}
        }

        if (fullyLocked) {
            info.unsupportedReason = "The text layer is fully locked.";
        } else if (info.contents === null) {
            info.unsupportedReason = "The current text contents could not be read safely.";
        } else if (!ranges.available) {
            info.unsupportedReason = ranges.error || "Text style ranges are unavailable.";
        } else if (info.hasMultipleTextStyleRanges || info.hasMultipleParagraphStyleRanges) {
            info.unsupportedReason = "Layer has unsupported mixed text or paragraph styling.";
        } else if (ranges.textStyleRangeCount !== 1 || ranges.paragraphStyleRangeCount !== 1) {
            info.unsupportedReason = "Layer does not have one safely addressable text and paragraph style range.";
        } else {
            info.safeForContentOnlyReplacement = true;
        }
        return info;
    }
    function safeBounds(layer) {
        try {
            var b = layer.bounds;
            return { left: toPixels(b[0]), top: toPixels(b[1]), right: toPixels(b[2]), bottom: toPixels(b[3]) };
        } catch (_error) { return null; }
    }
    function serializeLayer(layer, parentNames, indexPath) {
        var names = parentNames.slice(0); names.push(layer.name);
        var textLayer = isTextLayer(layer);
        var item = {
            id: safeLayerId(layer), name: layer.name, path: names.join(" / "), indexPath: indexPath.slice(0),
            typename: layer.typename, kind: safeLayerKind(layer), isSmartObject: isSmartObject(layer),
            isGroup: layer.typename === "LayerSet", visible: Boolean(layer.visible), opacity: Number(layer.opacity),
            bounds: safeBounds(layer), children: []
        };
        if (textLayer) {
            try {
                item.textInfo = inspectTextInfo(layer);
            } catch (error) {
                item.textInfo = {
                    contents: null,
                    textType: null,
                    justification: null,
                    font: null,
                    size: null,
                    color: null,
                    hasMultipleTextStyleRanges: null,
                    hasMultipleParagraphStyleRanges: null,
                    safeForContentOnlyReplacement: false,
                    unsupportedReason: "Optional text metadata could not be inspected: " + error.message
                };
            }
        }
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
            guidance: "Use a fresh numeric layer ID. Text layers include textInfo; only layers marked safeForContentOnlyReplacement are eligible for text updates."
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
    function validatePlainTextOutputFileName(fileName, extension) {
        if (typeof fileName !== "string" || fileName.length < extension.length + 1 || fileName.length > 255) {
            throw new Error("Expected a plain " + extension + " output file name.");
        }
        if (/[\\\/\x00-\x1f<>:"|?*]/.test(fileName) || fileName.indexOf("..") !== -1 || /^[A-Za-z]:/.test(fileName) || /^\./.test(fileName)) {
            throw new Error("Output file names must be plain names without paths, traversal, drive letters, or invalid characters.");
        }
        var lower = fileName.toLowerCase();
        if (lower.substring(lower.length - extension.length) !== extension) {
            throw new Error("Expected a " + extension + " output file name.");
        }
        var baseName = lower.substring(0, lower.length - extension.length);
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(baseName)) {
            throw new Error("The output uses a reserved device file name.");
        }
    }
    function validateTextEdit(edit, seenIds) {
        if (!edit || typeof edit.text !== "string") throw new Error("Every text edit requires a string text value.");
        var layerId = Number(edit.layerId);
        if (!isFinite(layerId) || layerId <= 0 || Math.floor(layerId) !== layerId) {
            throw new Error("Every text-edit layerId must be a positive integer.");
        }
        if (seenIds[String(layerId)]) throw new Error("Duplicate text-edit layerId: " + layerId);
        seenIds[String(layerId)] = true;
        if (edit.text.length > 4000) throw new Error("Each replacement text value is limited to 4,000 characters.");
        if (edit.text.indexOf("\u0000") !== -1) throw new Error("Replacement text must not contain null bytes.");
        return { layerId: layerId, text: edit.text };
    }
    function resolveSourceTextTargets(document, edits) {
        if (!(edits instanceof Array) || edits.length < 1 || edits.length > 25) {
            throw new Error("Text edits must contain 1 through 25 entries.");
        }
        var targets = [], seenIds = {}, totalLength = 0;
        for (var i = 0; i < edits.length; i++) {
            var edit = validateTextEdit(edits[i], seenIds);
            totalLength += edit.text.length;
            if (totalLength > 20000) throw new Error("Total replacement text is limited to 20,000 characters.");

            var matches = [];
            findLayerRecursive(document.layers, function (layer) {
                return safeLayerId(layer) === edit.layerId;
            }, [], matches);
            if (matches.length !== 1) throw new Error("Text layer ID " + edit.layerId + " was not found uniquely.");
            if (!isTextLayer(matches[0].layer)) throw new Error("Layer ID " + edit.layerId + " is not a Photoshop text layer.");

            var textInfo = inspectTextInfo(matches[0].layer);
            if (!textInfo.safeForContentOnlyReplacement) {
                throw new Error('Text layer "' + layerPathAtIndexPath(document, matches[0].indexPath) + '" is unsupported: ' + textInfo.unsupportedReason);
            }
            targets.push({
                layer: matches[0].layer,
                indexPath: matches[0].indexPath,
                path: layerPathAtIndexPath(document, matches[0].indexPath),
                previousText: textInfo.contents,
                edit: edit
            });
        }
        return targets;
    }
    function applyContentOnlyTextEdit(layer, requestedText) {
        if (!isTextLayer(layer)) throw new Error("The duplicated target is no longer a Photoshop text layer.");
        var originalName = layer.name;
        var normalizedRequested = normalizeTextForResult(requestedText);
        layer.textItem.contents = normalizeTextForPhotoshop(requestedText);
        if (layer.name !== originalName) layer.name = originalName;
        var observed = normalizeTextForResult(layer.textItem.contents);
        if (observed !== normalizedRequested) {
            throw new Error("Photoshop did not retain the requested text exactly after line-ending normalization.");
        }
        return normalizedRequested;
    }
    function removeJobOutput(file, label, failures) {
        try {
            if (file.exists && !file.remove()) failures.push(label + " could not be removed");
        } catch (error) {
            failures.push(label + " could not be removed: " + error.message);
        }
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
    function updateTextLayers(input) {
        var payload = input.payload || {};
        validatePlainTextOutputFileName(payload.outputPsdName, ".psd");
        validatePlainTextOutputFileName(payload.outputPreviewName, ".png");

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

        // Resolve and validate every source layer before duplication or editing.
        var sourceTargets = resolveSourceTextTargets(sourceDocument, payload.edits);
        var outputBaseName = payload.outputPsdName.replace(/\.psd$/i, "");
        var workingDocument = null, previewDocument = null, outputPhaseStarted = false;
        try {
            workingDocument = sourceDocument.duplicate(outputBaseName, false);
            app.activeDocument = workingDocument;

            // Resolve and preflight every duplicate target before applying the first edit.
            var duplicateTargets = [];
            for (var i = 0; i < sourceTargets.length; i++) {
                var duplicateLayer = getLayerByIndexPath(workingDocument, sourceTargets[i].indexPath);
                if (!isTextLayer(duplicateLayer)) {
                    throw new Error('Duplicated target "' + sourceTargets[i].path + '" is no longer a Photoshop text layer.');
                }
                var duplicateInfo = inspectTextInfo(duplicateLayer);
                if (!duplicateInfo.safeForContentOnlyReplacement) {
                    throw new Error('Duplicated text layer "' + sourceTargets[i].path + '" is unsupported: ' + duplicateInfo.unsupportedReason);
                }
                if (duplicateInfo.contents !== sourceTargets[i].previousText) {
                    throw new Error('Duplicated text layer "' + sourceTargets[i].path + '" no longer matches the inspected source text.');
                }
                duplicateTargets.push({ layer: duplicateLayer, source: sourceTargets[i] });
            }

            var updatedLayers = [];
            for (var j = 0; j < duplicateTargets.length; j++) {
                var target = duplicateTargets[j];
                var newText;
                try {
                    newText = applyContentOnlyTextEdit(target.layer, target.source.edit.text);
                } catch (editError) {
                    throw new Error('Could not safely update text layer "' + target.source.path + '": ' + editError.message);
                }
                updatedLayers.push({
                    sourceLayerId: target.source.edit.layerId,
                    outputLayerId: safeLayerId(target.layer),
                    name: target.layer.name,
                    path: target.source.path,
                    previousText: target.source.previousText,
                    newText: newText
                });
            }

            var psdOptions = new PhotoshopSaveOptions();
            psdOptions.layers = true;
            psdOptions.embedColorProfile = true;
            psdOptions.alphaChannels = true;
            psdOptions.annotations = true;
            psdOptions.spotColors = true;
            if (outputPsd.exists || outputPreview.exists) {
                throw new Error("An output file appeared while the job was running. No output was saved.");
            }
            outputPhaseStarted = true;
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
                updatedLayers: updatedLayers,
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

            var cleanupFailures = [];
            if (outputPhaseStarted) {
                removeJobOutput(outputPreview, "Partial PNG output", cleanupFailures);
                removeJobOutput(outputPsd, "Partial PSD output", cleanupFailures);
            }
            if (cleanupFailures.length) {
                throw new Error(error.message + " Cleanup error: " + cleanupFailures.join("; ") + ".");
            }
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
    if (input.type === "updateTextLayers") {
        return updateTextLayers(input);
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
