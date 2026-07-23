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

        // ExtendScript installations do not consistently provide JSON.parse.
        // Use a strict recursive-descent parser instead of eval so a locally
        // selected manifest can never execute script code.
        var source = String(text), offset = 0;
        function fail(message) { throw new Error("Invalid JSON at character " + offset + ": " + message); }
        function whitespace() {
            while (offset < source.length && /[\x20\x09\x0a\x0d]/.test(source.charAt(offset))) offset++;
        }
        function parseString() {
            if (source.charAt(offset) !== '"') fail("Expected a string.");
            offset++;
            var result = "";
            while (offset < source.length) {
                var character = source.charAt(offset++), escaped, hex;
                if (character === '"') return result;
                if (character === "\\") {
                    if (offset >= source.length) fail("Unterminated escape sequence.");
                    escaped = source.charAt(offset++);
                    if (escaped === '"' || escaped === "\\" || escaped === "/") result += escaped;
                    else if (escaped === "b") result += "\b";
                    else if (escaped === "f") result += "\f";
                    else if (escaped === "n") result += "\n";
                    else if (escaped === "r") result += "\r";
                    else if (escaped === "t") result += "\t";
                    else if (escaped === "u") {
                        hex = source.substr(offset, 4);
                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid Unicode escape.");
                        result += String.fromCharCode(parseInt(hex, 16));
                        offset += 4;
                    } else fail("Invalid escape sequence.");
                } else {
                    if (character.charCodeAt(0) < 32) fail("Unescaped control character in string.");
                    result += character;
                }
            }
            fail("Unterminated string.");
        }
        function parseNumber() {
            var remainder = source.substring(offset);
            var match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remainder);
            if (!match) fail("Invalid number.");
            offset += match[0].length;
            var value = Number(match[0]);
            if (!isFinite(value)) fail("Number is outside the supported range.");
            return value;
        }
        function parseArray() {
            var result = [];
            offset++; whitespace();
            if (source.charAt(offset) === "]") { offset++; return result; }
            while (true) {
                result.push(parseValue()); whitespace();
                if (source.charAt(offset) === "]") { offset++; return result; }
                if (source.charAt(offset) !== ",") fail("Expected ',' or ']'.");
                offset++; whitespace();
            }
        }
        function parseObject() {
            var result = {};
            offset++; whitespace();
            if (source.charAt(offset) === "}") { offset++; return result; }
            while (true) {
                if (source.charAt(offset) !== '"') fail("Expected an object key.");
                var key = parseString();
                if (key === "__proto__" || key === "prototype" || key === "constructor") fail("Unsafe object key.");
                if (result.hasOwnProperty(key)) fail("Duplicate object key.");
                whitespace();
                if (source.charAt(offset) !== ":") fail("Expected ':'.");
                offset++; whitespace();
                result[key] = parseValue(); whitespace();
                if (source.charAt(offset) === "}") { offset++; return result; }
                if (source.charAt(offset) !== ",") fail("Expected ',' or '}'.");
                offset++; whitespace();
            }
        }
        function parseValue() {
            whitespace();
            var character = source.charAt(offset);
            if (character === '"') return parseString();
            if (character === "{") return parseObject();
            if (character === "[") return parseArray();
            if (character === "-" || /[0-9]/.test(character)) return parseNumber();
            if (source.substr(offset, 4) === "true") { offset += 4; return true; }
            if (source.substr(offset, 5) === "false") { offset += 5; return false; }
            if (source.substr(offset, 4) === "null") { offset += 4; return null; }
            fail("Expected a JSON value.");
        }
        var parsed = parseValue(); whitespace();
        if (offset !== source.length) fail("Unexpected trailing content.");
        return parsed;
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
    function safeTransformBounds(layer) {
        try {
            var b = layer.boundsNoEffects;
            return { left: toPixels(b[0]), top: toPixels(b[1]), right: toPixels(b[2]), bottom: toPixels(b[3]) };
        } catch (_noEffectBoundsError) { return safeBounds(layer); }
    }
    function activeLayerTransparencyBounds(document, layer, label) {
        app.activeDocument = document;
        document.activeLayer = layer;
        var descriptor = new ActionDescriptor(), selectionReference = new ActionReference(), transparencyReference = new ActionReference();
        selectionReference.putProperty(charIDToTypeID("Chnl"), charIDToTypeID("fsel"));
        descriptor.putReference(charIDToTypeID("null"), selectionReference);
        transparencyReference.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Trsp"));
        descriptor.putReference(charIDToTypeID("T   "), transparencyReference);
        try {
            executeAction(charIDToTypeID("setd"), descriptor, DialogModes.NO);
            var b = document.selection.bounds;
            return { left: toPixels(b[0]), top: toPixels(b[1]), right: toPixels(b[2]), bottom: toPixels(b[3]) };
        } catch (error) {
            throw new Error("Could not measure alpha-visible pixels for " + label + ": " + error.message);
        } finally {
            try { document.selection.deselect(); } catch (_alphaBoundsDeselectError) {}
        }
    }
    function smartObjectPlacementTransform(layer) {
        try {
            var layerId = safeLayerId(layer);
            if (!layerId) return null;
            var reference = new ActionReference();
            reference.putIdentifier(charIDToTypeID("Lyr "), layerId);
            var layerDescriptor = executeActionGet(reference);
            var smartObjectMoreKey = stringIDToTypeID("smartObjectMore");
            if (!layerDescriptor.hasKey(smartObjectMoreKey)) return null;
            var smartObjectMore = layerDescriptor.getObjectValue(smartObjectMoreKey);
            var transformKey = stringIDToTypeID("transform");
            if (!smartObjectMore.hasKey(transformKey)) return null;
            var transformList = smartObjectMore.getList(transformKey), transform = [];
            for (var transformIndex = 0; transformIndex < transformList.count; transformIndex++) {
                var value = null;
                try { value = Number(transformList.getDouble(transformIndex)); }
                catch (_transformDoubleError) {
                    try { value = Number(transformList.getUnitDoubleValue(transformIndex)); }
                    catch (_transformUnitDoubleError) {
                        try { value = Number(transformList.getInteger(transformIndex)); }
                        catch (_transformIntegerError) { return null; }
                    }
                }
                if (!isFinite(value)) return null;
                transform.push(value);
            }
            return transform.length ? transform : null;
        } catch (_smartObjectTransformInspectionError) {
            return null;
        }
    }
    function descriptorUnitBound(boundsDescriptor, stringKey, charKey) {
        var stringId = stringIDToTypeID(stringKey), charId = charIDToTypeID(charKey);
        if (boundsDescriptor.hasKey(stringId)) return Number(boundsDescriptor.getUnitDoubleValue(stringId));
        if (boundsDescriptor.hasKey(charId)) return Number(boundsDescriptor.getUnitDoubleValue(charId));
        throw new Error("Missing " + stringKey + " bound.");
    }
    function safeBoundsWithoutMask(layer) {
        try {
            var propertyId = stringIDToTypeID("boundsNoMask"), layerId = safeLayerId(layer);
            if (!layerId) return null;
            var reference = new ActionReference();
            reference.putProperty(charIDToTypeID("Prpr"), propertyId);
            reference.putIdentifier(charIDToTypeID("Lyr "), layerId);
            var layerDescriptor = executeActionGet(reference);
            if (!layerDescriptor.hasKey(propertyId)) return null;
            var boundsDescriptor = layerDescriptor.getObjectValue(propertyId);
            return {
                left: descriptorUnitBound(boundsDescriptor, "left", "Left"),
                top: descriptorUnitBound(boundsDescriptor, "top", "Top "),
                right: descriptorUnitBound(boundsDescriptor, "right", "Rght"),
                bottom: descriptorUnitBound(boundsDescriptor, "bottom", "Btom")
            };
        } catch (_boundsWithoutMaskError) {
            return null;
        }
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
        if (/[. ]$/.test(baseName)) throw new Error("Output file name stems must not end in a dot or space.");
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
    function validatePlainOutputStem(value) {
        if (typeof value !== "string" || value.length < 1 || value.length > 200) {
            throw new Error("Expected a plain output file name stem.");
        }
        if (/[\\\/\x00-\x1f<>:"|?*]/.test(value) || value.indexOf("..") !== -1 || /^[A-Za-z]:/.test(value) || /^\./.test(value) || /[. ]$/.test(value)) {
            throw new Error("Output stems must be plain names without paths, traversal, drive letters, or invalid characters.");
        }
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
            throw new Error("The output stem uses a reserved device file name.");
        }
    }
    function validateLayerIdList(layerIds, maximum) {
        if (!(layerIds instanceof Array) || layerIds.length < 1 || layerIds.length > maximum) {
            throw new Error("Layer IDs must contain 1 through " + maximum + " entries.");
        }
        var ids = [], seen = {};
        for (var i = 0; i < layerIds.length; i++) {
            var layerId = Number(layerIds[i]);
            if (!isFinite(layerId) || layerId <= 0 || Math.floor(layerId) !== layerId) {
                throw new Error("Every layer ID must be a positive integer.");
            }
            if (seen[String(layerId)]) throw new Error("Duplicate layer ID: " + layerId);
            seen[String(layerId)] = true;
            ids.push(layerId);
        }
        return ids;
    }
    function resolveSourceLayersByIds(document, layerIds) {
        var ids = validateLayerIdList(layerIds, 12), targets = [];
        for (var i = 0; i < ids.length; i++) {
            var matches = [], wantedId = ids[i];
            findLayerRecursive(document.layers, function (layer) {
                return safeLayerId(layer) === wantedId;
            }, [], matches);
            if (matches.length !== 1) throw new Error("Layer ID " + wantedId + " was not found uniquely.");
            targets.push({
                sourceLayerId: wantedId,
                name: matches[0].layer.name,
                path: layerPathAtIndexPath(document, matches[0].indexPath),
                indexPath: matches[0].indexPath
            });
        }
        return targets;
    }
    function indexPathIsPrefix(prefix, path) {
        if (prefix.length > path.length) return false;
        for (var i = 0; i < prefix.length; i++) if (Number(prefix[i]) !== Number(path[i])) return false;
        return true;
    }
    function clippingContextPaths(document, targetPath) {
        var paths = [targetPath.slice(0)], collection = document.layers;
        for (var i = 0; i < targetPath.length - 1; i++) collection = collection[Number(targetPath[i])].layers;
        var targetIndex = Number(targetPath[targetPath.length - 1]);
        var target = collection[targetIndex], grouped = false;
        try { grouped = target.typename === "ArtLayer" && Boolean(target.grouped); } catch (_groupedError) {}
        if (grouped) {
            for (var j = targetIndex + 1; j < collection.length; j++) {
                var contextPath = targetPath.slice(0, targetPath.length - 1); contextPath.push(j);
                paths.push(contextPath);
                var stillGrouped = false;
                try { stillGrouped = collection[j].typename === "ArtLayer" && Boolean(collection[j].grouped); } catch (_contextGroupedError) {}
                if (!stillGrouped) break;
            }
        }
        return paths;
    }
    function isolateVisibleLayers(layers, parentPath, keepPaths) {
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i], currentPath = parentPath.slice(0); currentPath.push(i);
            var ancestorOrTarget = false, descendantOfKeptGroup = false;
            for (var j = 0; j < keepPaths.length; j++) {
                if (indexPathIsPrefix(currentPath, keepPaths[j])) ancestorOrTarget = true;
                if (indexPathIsPrefix(keepPaths[j], currentPath)) descendantOfKeptGroup = true;
            }
            if (ancestorOrTarget) layer.visible = true;
            else if (!descendantOfKeptGroup) layer.visible = false;
            if (layer.typename === "LayerSet" && (ancestorOrTarget || descendantOfKeptGroup)) {
                isolateVisibleLayers(layer.layers, currentPath, keepPaths);
            }
        }
    }
    function duplicateIsolatedDocument(sourceDocument, target, duplicateName) {
        var duplicate = null;
        try {
            duplicate = sourceDocument.duplicate(duplicateName, false);
            app.activeDocument = duplicate;
            var duplicateTarget = getLayerByIndexPath(duplicate, target.indexPath);
            var keepPaths = clippingContextPaths(duplicate, target.indexPath);
            isolateVisibleLayers(duplicate.layers, [], keepPaths);
            duplicate.activeLayer = duplicateTarget;
            return duplicate;
        } catch (error) {
            if (duplicate) {
                try { duplicate.close(SaveOptions.DONOTSAVECHANGES); } catch (_duplicateCloseError) {}
            }
            try { app.activeDocument = sourceDocument; } catch (_activateSourceError) {}
            throw error;
        }
    }
    function trimWithMargin(document, marginPx) {
        try {
            document.trim(TrimType.TRANSPARENT, true, true, true, true);
        } catch (error) {
            throw new Error("The isolated layer has no trimmable visible pixels: " + error.message);
        }
        if (marginPx > 0) {
            var width = toPixels(document.width), height = toPixels(document.height);
            document.resizeCanvas(
                UnitValue(width + (marginPx * 2), "px"),
                UnitValue(height + (marginPx * 2), "px"),
                AnchorPosition.MIDDLECENTER
            );
        }
    }
    function savePng(document, outputFile) {
        try {
            if (document.mode !== DocumentMode.RGB) document.changeMode(ChangeMode.RGB);
        } catch (error) {
            throw new Error("The temporary document could not be converted to RGB for PNG export: " + error.message);
        }
        var pngOptions = new PNGSaveOptions();
        pngOptions.interlaced = false;
        document.saveAs(outputFile, pngOptions, true, Extension.LOWERCASE);
    }
    function assertNoExistingOutputs(files) {
        for (var i = 0; i < files.length; i++) {
            if (files[i].exists) throw new Error("An output file already exists: " + files[i].name);
        }
    }
    function cleanupAttemptedOutputs(files, failures) {
        for (var i = files.length - 1; i >= 0; i--) removeJobOutput(files[i], "Partial output " + files[i].name, failures);
    }
    function exportDocumentPreview(input) {
        var payload = input.payload || {};
        validatePlainTextOutputFileName(payload.outputPreviewName, ".png");
        var sourceDocument = getDocument(payload.documentName);
        app.activeDocument = sourceDocument;
        var workingFolder = new Folder(input.workingFolder);
        if (!workingFolder.exists) throw new Error("Working folder does not exist: " + input.workingFolder);
        var outputPreview = childFile(workingFolder, payload.outputPreviewName);
        assertNoExistingOutputs([outputPreview]);

        var previewDocument = null, outputAttempted = false;
        try {
            previewDocument = sourceDocument.duplicate(payload.outputPreviewName.replace(/\.png$/i, "_preview"), true);
            app.activeDocument = previewDocument;
            previewDocument.flatten();
            if (outputPreview.exists) throw new Error("The preview output appeared while the job was running.");
            outputAttempted = true;
            savePng(previewDocument, outputPreview);
            previewDocument.close(SaveOptions.DONOTSAVECHANGES);
            previewDocument = null;
            app.activeDocument = sourceDocument;
            return {
                documentName: sourceDocument.name,
                outputPreviewPath: outputPreview.fsName,
                originalPreserved: true
            };
        } catch (error) {
            if (previewDocument) {
                try { previewDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_previewCloseError) {}
            }
            try { app.activeDocument = sourceDocument; } catch (_activateSourceError) {}
            var cleanupFailures = [];
            if (outputAttempted) removeJobOutput(outputPreview, "Partial PNG output", cleanupFailures);
            if (cleanupFailures.length) throw new Error(error.message + " Cleanup error: " + cleanupFailures.join("; ") + ".");
            throw error;
        }
    }
    function truncateLabel(value, maximum) {
        var text = String(value);
        return text.length <= maximum ? text : text.substring(0, maximum - 1) + "…";
    }
    function addContactSheetLabel(sheet, target, left, baseline) {
        var label = sheet.artLayers.add();
        label.kind = LayerKind.TEXT;
        label.name = "Label " + target.sourceLayerId;
        label.textItem.contents = "ID " + target.sourceLayerId + " | " + truncateLabel(target.name, 45) + "\r" + truncateLabel(target.path, 75);
        label.textItem.position = [UnitValue(left, "px"), UnitValue(baseline, "px")];
        label.textItem.size = UnitValue(12, "pt");
        var black = new SolidColor(); black.rgb.red = 0; black.rgb.green = 0; black.rgb.blue = 0;
        label.textItem.color = black;
    }
    function placeIsolatedPreviewOnSheet(sourceDocument, target, sheet, tileLeft, tileTop, marginPx, duplicateName) {
        var isolated = null;
        try {
            isolated = duplicateIsolatedDocument(sourceDocument, target, duplicateName);
            trimWithMargin(isolated, 0);
            var width = toPixels(isolated.width), height = toPixels(isolated.height);
            var maxWidth = 480, maxHeight = 340;
            var scale = Math.min(1, maxWidth / width, maxHeight / height);
            if (scale < 1) {
                isolated.resizeImage(
                    UnitValue(Math.max(1, Math.round(width * scale)), "px"),
                    UnitValue(Math.max(1, Math.round(height * scale)), "px"),
                    isolated.resolution,
                    ResampleMethod.BICUBICSHARPER
                );
            }
            isolated.selection.selectAll();
            isolated.selection.copy(true);
            isolated.selection.deselect();
            app.activeDocument = sheet;
            sheet.paste();
            var pasted = sheet.activeLayer, bounds = safeBounds(pasted);
            if (!bounds) throw new Error("Could not determine the pasted preview bounds.");
            var tileWidth = 480 + (marginPx * 2), contentHeight = 340 + (marginPx * 2);
            var desiredCenterX = tileLeft + (tileWidth / 2), desiredCenterY = tileTop + (contentHeight / 2);
            pasted.translate(UnitValue(desiredCenterX - ((bounds.left + bounds.right) / 2), "px"), UnitValue(desiredCenterY - ((bounds.top + bounds.bottom) / 2), "px"));
            pasted.name = "Layer " + target.sourceLayerId + " - " + target.name;
            isolated.close(SaveOptions.DONOTSAVECHANGES);
            isolated = null;
        } catch (error) {
            if (isolated) {
                try { isolated.close(SaveOptions.DONOTSAVECHANGES); } catch (_isolatedCloseError) {}
            }
            throw error;
        }
    }
    function exportContactSheet(sourceDocument, targets, outputFile, marginPx, baseOutputName) {
        var columns = Math.min(3, targets.length), rows = Math.ceil(targets.length / columns);
        var tileWidth = 480 + (marginPx * 2), tileHeight = 410 + (marginPx * 2);
        var sheet = app.documents.add(
            UnitValue(tileWidth * columns, "px"),
            UnitValue(tileHeight * rows, "px"),
            72,
            baseOutputName + "_contact_sheet",
            NewDocumentMode.RGB,
            DocumentFill.TRANSPARENT
        );
        try {
            for (var i = 0; i < targets.length; i++) {
                var column = i % columns, row = Math.floor(i / columns);
                var left = column * tileWidth, top = row * tileHeight;
                placeIsolatedPreviewOnSheet(sourceDocument, targets[i], sheet, left, top, marginPx, baseOutputName + "_contact_" + targets[i].sourceLayerId);
                app.activeDocument = sheet;
                addContactSheetLabel(sheet, targets[i], left + marginPx + 8, top + (marginPx * 2) + 370);
            }
            if (outputFile.exists) throw new Error("The contact-sheet output appeared while the job was running.");
            savePng(sheet, outputFile);
            sheet.close(SaveOptions.DONOTSAVECHANGES);
            return null;
        } catch (error) {
            try { sheet.close(SaveOptions.DONOTSAVECHANGES); } catch (_sheetCloseError) {}
            throw error;
        }
    }
    function exportLayerPreviews(input) {
        var payload = input.payload || {};
        validatePlainOutputStem(payload.baseOutputName);
        var mode = String(payload.mode || "");
        if (mode !== "isolated-transparent" && mode !== "isolated-on-canvas" && mode !== "contact-sheet") {
            throw new Error("Unsupported layer preview mode: " + mode);
        }
        var marginPx = typeof payload.marginPx === "undefined" ? 40 : Number(payload.marginPx);
        if (!isFinite(marginPx) || marginPx < 0 || marginPx > 400 || Math.floor(marginPx) !== marginPx) {
            throw new Error("Layer preview marginPx must be an integer from 0 through 400.");
        }
        var sourceDocument = getDocument(payload.documentName);
        app.activeDocument = sourceDocument;
        var targets = resolveSourceLayersByIds(sourceDocument, payload.layerIds);
        var workingFolder = new Folder(input.workingFolder);
        if (!workingFolder.exists) throw new Error("Working folder does not exist: " + input.workingFolder);

        var outputFiles = [], i;
        if (mode === "contact-sheet") {
            outputFiles.push(childFile(workingFolder, payload.baseOutputName + "_contact_sheet.png"));
        } else {
            for (i = 0; i < targets.length; i++) outputFiles.push(childFile(workingFolder, payload.baseOutputName + "_layer_" + targets[i].sourceLayerId + ".png"));
        }
        assertNoExistingOutputs(outputFiles);

        var temporaryDocument = null, attemptedOutputs = [], previews = [];
        try {
            if (mode === "contact-sheet") {
                attemptedOutputs.push(outputFiles[0]);
                exportContactSheet(sourceDocument, targets, outputFiles[0], marginPx, payload.baseOutputName);
                for (i = 0; i < targets.length; i++) {
                    previews.push({
                        sourceLayerId: targets[i].sourceLayerId,
                        name: targets[i].name,
                        path: targets[i].path,
                        outputPreviewPath: outputFiles[0].fsName
                    });
                }
            } else {
                for (i = 0; i < targets.length; i++) {
                    temporaryDocument = duplicateIsolatedDocument(sourceDocument, targets[i], payload.baseOutputName + "_layer_" + targets[i].sourceLayerId);
                    if (mode === "isolated-transparent") trimWithMargin(temporaryDocument, marginPx);
                    if (outputFiles[i].exists) throw new Error("An output file appeared while the job was running: " + outputFiles[i].name);
                    attemptedOutputs.push(outputFiles[i]);
                    savePng(temporaryDocument, outputFiles[i]);
                    temporaryDocument.close(SaveOptions.DONOTSAVECHANGES);
                    temporaryDocument = null;
                    previews.push({
                        sourceLayerId: targets[i].sourceLayerId,
                        name: targets[i].name,
                        path: targets[i].path,
                        outputPreviewPath: outputFiles[i].fsName
                    });
                }
            }
            app.activeDocument = sourceDocument;
            return {
                originalDocument: sourceDocument.name,
                mode: mode,
                previews: previews,
                contactSheetPath: mode === "contact-sheet" ? outputFiles[0].fsName : null,
                originalPreserved: true
            };
        } catch (error) {
            if (temporaryDocument) {
                try { temporaryDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_temporaryCloseError) {}
            }
            try { app.activeDocument = sourceDocument; } catch (_activateSourceError) {}
            var cleanupFailures = [];
            cleanupAttemptedOutputs(attemptedOutputs, cleanupFailures);
            if (cleanupFailures.length) throw new Error(error.message + " Cleanup error: " + cleanupFailures.join("; ") + ".");
            throw error;
        }
    }
    function validateRenameEdit(edit, seenIds) {
        if (!edit || typeof edit.newName !== "string") throw new Error("Every rename edit requires a string newName.");
        var layerId = Number(edit.layerId);
        if (!isFinite(layerId) || layerId <= 0 || Math.floor(layerId) !== layerId) throw new Error("Every rename layerId must be a positive integer.");
        if (seenIds[String(layerId)]) throw new Error("Duplicate rename layerId: " + layerId);
        seenIds[String(layerId)] = true;
        if (edit.newName.length < 1 || edit.newName.length > 255) throw new Error("Every new layer name must contain 1 through 255 characters.");
        if (edit.newName.indexOf("\u0000") !== -1) throw new Error("Layer names must not contain null bytes.");
        return { layerId: layerId, newName: edit.newName };
    }
    function resolveSourceRenameTargets(document, edits) {
        if (!(edits instanceof Array) || edits.length < 1 || edits.length > 50) throw new Error("Rename edits must contain 1 through 50 entries.");
        var targets = [], seenIds = {};
        for (var i = 0; i < edits.length; i++) {
            var edit = validateRenameEdit(edits[i], seenIds), matches = [];
            findLayerRecursive(document.layers, function (layer) { return safeLayerId(layer) === edit.layerId; }, [], matches);
            if (matches.length !== 1) throw new Error("Rename layer ID " + edit.layerId + " was not found uniquely.");
            targets.push({
                edit: edit,
                indexPath: matches[0].indexPath,
                oldName: matches[0].layer.name,
                path: layerPathAtIndexPath(document, matches[0].indexPath)
            });
        }
        return targets;
    }
    function renameLayers(input) {
        var payload = input.payload || {};
        validatePlainTextOutputFileName(payload.outputPsdName, ".psd");
        validatePlainTextOutputFileName(payload.outputPreviewName, ".png");
        var sourceDocument = getDocument(payload.documentName);
        app.activeDocument = sourceDocument;
        if (String(payload.outputPsdName).toLowerCase() === sourceDocument.name.toLowerCase()) throw new Error("The output PSD name must not match the original document.");
        var targets = resolveSourceRenameTargets(sourceDocument, payload.edits);
        var workingFolder = new Folder(input.workingFolder);
        if (!workingFolder.exists) throw new Error("Working folder does not exist: " + input.workingFolder);
        var outputPsd = childFile(workingFolder, payload.outputPsdName), outputPreview = childFile(workingFolder, payload.outputPreviewName);
        assertNoExistingOutputs([outputPsd, outputPreview]);

        var workingDocument = null, previewDocument = null, outputPhaseStarted = false;
        try {
            workingDocument = sourceDocument.duplicate(payload.outputPsdName.replace(/\.psd$/i, ""), false);
            app.activeDocument = workingDocument;
            var duplicateTargets = [], i;
            for (i = 0; i < targets.length; i++) {
                var duplicateLayer = getLayerByIndexPath(workingDocument, targets[i].indexPath);
                if (duplicateLayer.name !== targets[i].oldName) throw new Error('Duplicated target "' + targets[i].path + '" no longer matches the source name.');
                duplicateTargets.push({ layer: duplicateLayer, source: targets[i] });
            }
            var renamed = [];
            for (i = 0; i < duplicateTargets.length; i++) {
                var target = duplicateTargets[i];
                target.layer.name = target.source.edit.newName;
                if (target.layer.name !== target.source.edit.newName) throw new Error('Photoshop did not retain the requested name for "' + target.source.path + '" exactly.');
                renamed.push({
                    sourceLayerId: target.source.edit.layerId,
                    outputLayerId: safeLayerId(target.layer),
                    oldName: target.source.oldName,
                    newName: target.layer.name,
                    path: target.source.path
                });
            }
            if (outputPsd.exists || outputPreview.exists) throw new Error("An output file appeared while the job was running. No output was saved.");
            outputPhaseStarted = true;
            var psdOptions = new PhotoshopSaveOptions();
            psdOptions.layers = true; psdOptions.embedColorProfile = true; psdOptions.alphaChannels = true; psdOptions.annotations = true; psdOptions.spotColors = true;
            workingDocument.saveAs(outputPsd, psdOptions, false, Extension.LOWERCASE);
            previewDocument = workingDocument.duplicate(payload.outputPsdName.replace(/\.psd$/i, "_preview"), true);
            app.activeDocument = previewDocument;
            previewDocument.flatten();
            if (outputPreview.exists) throw new Error("The preview output appeared while the job was running.");
            savePng(previewDocument, outputPreview);
            previewDocument.close(SaveOptions.DONOTSAVECHANGES);
            previewDocument = null;
            app.activeDocument = workingDocument;
            return {
                originalDocument: sourceDocument.name,
                outputDocumentOpen: workingDocument.name,
                renamedLayers: renamed,
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
            if (cleanupFailures.length) throw new Error(error.message + " Cleanup error: " + cleanupFailures.join("; ") + ".");
            throw error;
        }
    }

    // ---------------------------------------------------------------------
    // Subscription-only match-card workflow
    // ---------------------------------------------------------------------
    var MATCH_ASSET_ROLES = [
        "competitorLeft", "competitorRight", "competitorCenter", "showLogo",
        "promotionLogo", "championshipLogo", "beltImage", "sponsorLogo",
        "venueLogo", "suppliedCharacterArtwork", "suppliedPhotograph"
    ];
    var MATCH_TEXT_ROLES = [
        "championship", "competitorLeftName", "competitorRightName",
        "competitorCenterName", "matchTitle", "stipulation", "date", "time", "venue"
    ];
    var MATCH_FONT_ROLES = [
        "mainTitle", "championshipLabel", "competitorNames", "stipulation",
        "date", "time", "venue"
    ];
    var MATCH_LAYOUT_PRESETS = [
        "two-competitor-title-center", "two-competitor-title-lower",
        "three-competitor-title-center", "single-competitor-title-side",
        "eccw-two-competitor-panel-template"
    ];
    var ECCW_PANEL_LAYOUT_PRESET = "eccw-two-competitor-panel-template";
    var ECCW_PANEL_TEMPLATE_FILE_NAME = "ECCW_JordanSinner_vs_EddieSlayer_template_bg_v1.png";
    var ECCW_PANEL_CANVAS_WIDTH = 1920;
    var ECCW_PANEL_CANVAS_HEIGHT = 1080;
    var ECCW_LOGO_WIDTH_VERIFICATION_TOLERANCE = 1;
    var ECCW_LOGO_MAX_CORRECTION_ITERATIONS = 3;
    var ECCW_VS_APPROVED_FILL = { red: 198, green: 24, blue: 32 };
    var MATCH_VISIBILITY_ROLES = [
        "templateBackground", "atmosphere", "framesAndPanels", "competitorRenders",
        "championshipAndBelt", "matchTitleGroup", "eventInformation", "showLogoGroup",
        "finishingEffects", "competitorLeft", "competitorRight", "competitorCenter",
        "showLogo", "promotionLogo", "championshipLogo", "beltImage", "sponsorLogo",
        "venueLogo", "suppliedCharacterArtwork", "suppliedPhotograph", "championship",
        "competitorLeftName", "competitorRightName", "competitorCenterName", "matchTitle",
        "stipulation", "date", "time", "venue"
    ];
    var MATCH_SUPPORTED_INPUT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".psd", ".tif", ".tiff"];

    function own(object, key) { return object && Object.prototype.hasOwnProperty.call(object, key); }
    function valueInList(value, list) {
        for (var i = 0; i < list.length; i++) if (list[i] === value) return true;
        return false;
    }
    function ownKeys(object) {
        var keys = [];
        for (var key in object) if (own(object, key)) keys.push(key);
        return keys;
    }
    function requirePlainObject(value, label) {
        if (!value || typeof value !== "object" || value instanceof Array) throw new Error(label + " must be an object.");
        return value;
    }
    function assertAllowedKeys(object, allowed, label) {
        requirePlainObject(object, label);
        for (var key in object) {
            if (own(object, key) && !valueInList(key, allowed)) throw new Error(label + " contains unsupported property: " + key);
        }
    }
    function requireString(value, label, minimum, maximum, allowEmpty) {
        if (typeof value !== "string") throw new Error(label + " must be a string.");
        if ((!allowEmpty && value.length < minimum) || value.length > maximum) {
            throw new Error(label + " must contain " + minimum + " through " + maximum + " characters.");
        }
        if (value.indexOf("\u0000") !== -1) throw new Error(label + " must not contain null bytes.");
        return value;
    }
    function fileExtension(fileName) {
        var dot = String(fileName).lastIndexOf(".");
        return dot < 0 ? "" : String(fileName).substring(dot).toLowerCase();
    }
    function validateMatchFileName(fileName, extensions, label) {
        requireString(fileName, label, 1, 255, false);
        if (/[\\\/\x00-\x1f<>:"|?*]/.test(fileName) || fileName.indexOf("..") !== -1 || /^[A-Za-z]:/.test(fileName) || /^\./.test(fileName)) {
            throw new Error(label + " must be a plain filename without paths, traversal, drive letters, or invalid characters.");
        }
        var lowerName = fileName.toLowerCase(), extension = "", extensionIndex;
        for (extensionIndex = 0; extensionIndex < extensions.length; extensionIndex++) {
            var candidate = String(extensions[extensionIndex]).toLowerCase();
            if (lowerName.length > candidate.length && lowerName.substring(lowerName.length - candidate.length) === candidate && candidate.length > extension.length) extension = candidate;
        }
        if (!extension) throw new Error(label + " has an unsupported extension.");
        var baseName = fileName.substring(0, fileName.length - extension.length);
        if (!baseName || /[. ]$/.test(baseName)) throw new Error(label + " must not have an empty stem or a stem ending in a dot or space.");
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(baseName)) throw new Error(label + " uses a reserved device filename.");
        return fileName;
    }
    function validateMatchOutputNames(payload) {
        validateMatchFileName(payload.outputPsdName, [".psd"], "outputPsdName");
        validateMatchFileName(payload.outputPreviewName, [".png"], "outputPreviewName");
        validateMatchFileName(payload.outputManifestName, [".matchcard.json"], "outputManifestName");
        var names = [payload.outputPsdName, payload.outputPreviewName, payload.outputManifestName], seen = {};
        for (var i = 0; i < names.length; i++) {
            var lowered = names[i].toLowerCase();
            if (seen[lowered]) throw new Error("Output filenames must be distinct.");
            seen[lowered] = true;
        }
    }
    function validateRgb(value, label) {
        assertAllowedKeys(requirePlainObject(value, label), ["red", "green", "blue"], label);
        var result = {}, channels = ["red", "green", "blue"];
        for (var i = 0; i < channels.length; i++) {
            var channel = channels[i], number = Number(value[channel]);
            if (!own(value, channel) || !isFinite(number) || number < 0 || number > 255 || Math.floor(number) !== number) {
                throw new Error(label + "." + channel + " must be an integer from 0 through 255.");
            }
            result[channel] = number;
        }
        return result;
    }
    function validateCanvas(value) {
        assertAllowedKeys(requirePlainObject(value, "canvas"), ["width", "height", "resolution"], "canvas");
        var width = Number(value.width), height = Number(value.height), resolution = Number(value.resolution);
        if (!isFinite(width) || Math.floor(width) !== width || width < 320 || width > 8192) throw new Error("canvas.width must be an integer from 320 through 8192.");
        if (!isFinite(height) || Math.floor(height) !== height || height < 320 || height > 8192) throw new Error("canvas.height must be an integer from 320 through 8192.");
        if (!isFinite(resolution) || Math.floor(resolution) !== resolution || resolution < 36 || resolution > 600) throw new Error("canvas.resolution must be an integer from 36 through 600.");
        if (width * height > 40000000) throw new Error("The canvas is limited to 40,000,000 pixels.");
    }
    function validateTemplateBackground(value) {
        assertAllowedKeys(requirePlainObject(value, "templateBackground"), ["fileName", "fitMode"], "templateBackground");
        validateMatchFileName(value.fileName, [".png"], "templateBackground.fileName");
        if (value.fitMode !== "contain" && value.fitMode !== "cover") throw new Error("templateBackground.fitMode must be contain or cover.");
    }
    function validateFontMap(value, label) {
        assertAllowedKeys(requirePlainObject(value, label), MATCH_FONT_ROLES, label);
        var keys = ownKeys(value);
        if (!keys.length) throw new Error(label + " must contain at least one font request.");
        for (var i = 0; i < keys.length; i++) {
            requireString(value[keys[i]], label + "." + keys[i], 1, 100, false);
            if (/[\x00-\x1f\x7f]/.test(value[keys[i]])) throw new Error(label + "." + keys[i] + " contains control characters.");
        }
    }
    function validateCreateStyle(value) {
        assertAllowedKeys(requirePlainObject(value, "style"), ["description", "primaryColor", "secondaryColor", "accentColor", "metallicColor", "layoutPreset", "fonts"], "style");
        requireString(value.description, "style.description", 1, 500, false);
        validateRgb(value.primaryColor, "style.primaryColor");
        validateRgb(value.secondaryColor, "style.secondaryColor");
        validateRgb(value.accentColor, "style.accentColor");
        validateRgb(value.metallicColor, "style.metallicColor");
        if (!valueInList(value.layoutPreset, MATCH_LAYOUT_PRESETS)) throw new Error("style.layoutPreset is unsupported.");
        if (own(value, "fonts")) validateFontMap(value.fonts, "style.fonts");
    }
    function validateUpdateStyle(value) {
        assertAllowedKeys(requirePlainObject(value, "changes.style"), ["primaryColor", "secondaryColor", "accentColor", "metallicColor", "fonts"], "changes.style");
        var keys = ownKeys(value);
        if (!keys.length) throw new Error("changes.style must contain at least one change.");
        for (var i = 0; i < keys.length; i++) {
            if (keys[i] === "fonts") validateFontMap(value.fonts, "changes.style.fonts");
            else validateRgb(value[keys[i]], "changes.style." + keys[i]);
        }
    }
    function validateAssetMap(value, label, requireCore) {
        assertAllowedKeys(requirePlainObject(value, label), MATCH_ASSET_ROLES, label);
        var keys = ownKeys(value);
        if (!keys.length) throw new Error(label + " must contain at least one asset.");
        for (var i = 0; i < keys.length; i++) validateMatchFileName(value[keys[i]], MATCH_SUPPORTED_INPUT_EXTENSIONS, label + "." + keys[i]);
        if (requireCore) {
            if (!own(value, "showLogo")) throw new Error("assets.showLogo is required.");
            if (!own(value, "competitorLeft") && !own(value, "competitorRight") && !own(value, "competitorCenter")) {
                throw new Error("At least one competitor asset is required.");
            }
        }
    }
    function validateTextMap(value, label) {
        assertAllowedKeys(requirePlainObject(value, label), MATCH_TEXT_ROLES, label);
        var keys = ownKeys(value), total = 0;
        if (!keys.length) throw new Error(label + " must contain at least one text field.");
        for (var i = 0; i < keys.length; i++) {
            requireString(value[keys[i]], label + "." + keys[i], 0, 1000, true);
            total += value[keys[i]].length;
        }
        if (total > 5000) throw new Error(label + " is limited to 5,000 total characters.");
    }
    function validatePlacement(value, label) {
        var fields = ["coordinateSpace", "x", "y", "fitMode", "scale", "maxWidth", "maxHeight", "clippingMask", "nonGenerativeMask", "dropShadow", "outerGlow"];
        assertAllowedKeys(requirePlainObject(value, label), fields, label);
        var coordinateSpace = own(value, "coordinateSpace") ? value.coordinateSpace : "normalized";
        if (coordinateSpace !== "normalized" && coordinateSpace !== "pixels") throw new Error(label + ".coordinateSpace must be normalized or pixels.");
        if (own(value, "x") !== own(value, "y")) throw new Error(label + ".x and .y must be supplied together.");
        if (own(value, "x")) {
            var x = Number(value.x), y = Number(value.y);
            if (!isFinite(x) || !isFinite(y)) throw new Error(label + ".x and .y must be finite numbers.");
            if (coordinateSpace === "normalized") {
                if (x < 0 || x > 1 || y < 0 || y > 1) throw new Error(label + " normalized x/y must be from 0 through 1.");
            } else if (Math.floor(x) !== x || Math.floor(y) !== y || x < -16384 || x > 16384 || y < -16384 || y > 16384) {
                throw new Error(label + " pixel x/y must be integers from -16384 through 16384.");
            }
        }
        if (own(value, "fitMode") && value.fitMode !== "contain" && value.fitMode !== "cover" && value.fitMode !== "keep-transform") throw new Error(label + ".fitMode is unsupported.");
        if (own(value, "scale")) {
            var scale = Number(value.scale);
            if (!isFinite(scale) || scale < 0.05 || scale > 10) throw new Error(label + ".scale must be from 0.05 through 10.");
        }
        var dimensions = ["maxWidth", "maxHeight"];
        for (var i = 0; i < dimensions.length; i++) if (own(value, dimensions[i])) {
            var dimension = Number(value[dimensions[i]]);
            if (!isFinite(dimension)) throw new Error(label + "." + dimensions[i] + " must be a finite number.");
            if (coordinateSpace === "normalized") {
                if (dimension <= 0 || dimension > 1) throw new Error(label + " normalized maximum dimensions must be greater than 0 and at most 1.");
            } else if (Math.floor(dimension) !== dimension || dimension < 1 || dimension > 16384) {
                throw new Error(label + " pixel maximum dimensions must be integers from 1 through 16384.");
            }
        }
        var booleans = ["clippingMask", "nonGenerativeMask", "dropShadow", "outerGlow"];
        for (var j = 0; j < booleans.length; j++) if (own(value, booleans[j]) && typeof value[booleans[j]] !== "boolean") throw new Error(label + "." + booleans[j] + " must be boolean.");
    }
    function validatePlacements(value, label) {
        assertAllowedKeys(requirePlainObject(value, label), MATCH_ASSET_ROLES, label);
        var keys = ownKeys(value);
        if (!keys.length) throw new Error(label + " must contain at least one placement.");
        for (var i = 0; i < keys.length; i++) validatePlacement(value[keys[i]], label + "." + keys[i]);
    }
    function validateOptionalRange(object, key, minimum, maximum, label) {
        if (!own(object, key)) return;
        var value = Number(object[key]);
        if (!isFinite(value) || value < minimum || value > maximum) {
            throw new Error(label + "." + key + " must be from " + minimum + " through " + maximum + ".");
        }
    }
    function eccwRgbEqual(left, right, tolerance) {
        tolerance = Number(tolerance || 0);
        return Boolean(left && right) &&
            Math.abs(Number(left.red) - Number(right.red)) <= tolerance &&
            Math.abs(Number(left.green) - Number(right.green)) <= tolerance &&
            Math.abs(Number(left.blue) - Number(right.blue)) <= tolerance;
    }
    function eccwRgbText(value) {
        return "rgb(" + Number(value.red) + "," + Number(value.green) + "," + Number(value.blue) + ")";
    }
    function resolveEccwVsFill(requestedFill) {
        if (requestedFill && !eccwRgbEqual(requestedFill, ECCW_VS_APPROVED_FILL, 0)) {
            throw new Error(
                "artDirection.vs.fill must match the ECCW preset-approved fill: expected=" +
                eccwRgbText(ECCW_VS_APPROVED_FILL) + " actual=" + eccwRgbText(requestedFill) + "."
            );
        }
        return cloneJsonValue(ECCW_VS_APPROVED_FILL);
    }
    function validateEccwShadow(value, label) {
        assertAllowedKeys(requirePlainObject(value, label), ["enabled", "opacity", "distance", "blur"], label);
        if (own(value, "enabled") && typeof value.enabled !== "boolean") throw new Error(label + ".enabled must be boolean.");
        validateOptionalRange(value, "opacity", 0, 60, label);
        validateOptionalRange(value, "distance", 0, 40, label);
        validateOptionalRange(value, "blur", 0, 40, label);
    }
    function validateEccwStroke(value, label) {
        assertAllowedKeys(requirePlainObject(value, label), ["enabled", "color", "size", "opacity"], label);
        if (own(value, "enabled") && typeof value.enabled !== "boolean") throw new Error(label + ".enabled must be boolean.");
        if (own(value, "color")) validateRgb(value.color, label + ".color");
        validateOptionalRange(value, "size", 0, 8, label);
        validateOptionalRange(value, "opacity", 0, 100, label);
    }
    function validateEccwTopTextDirection(value, label, allowText) {
        var fields = ["fontSize", "xOffset", "yOffset", "fill", "stroke", "shadow"];
        if (allowText) fields.push("text");
        assertAllowedKeys(requirePlainObject(value, label), fields, label);
        if (allowText && own(value, "text")) requireString(value.text, label + ".text", 1, 160, false);
        validateOptionalRange(value, "fontSize", 18, 100, label);
        validateOptionalRange(value, "xOffset", -150, 150, label);
        validateOptionalRange(value, "yOffset", -150, 150, label);
        if (own(value, "fill")) validateRgb(value.fill, label + ".fill");
        if (own(value, "stroke")) validateEccwStroke(value.stroke, label + ".stroke");
        if (own(value, "shadow")) validateEccwShadow(value.shadow, label + ".shadow");
    }
    function validateEccwCompetitorDirection(value, label) {
        var fields = ["scale", "xOffset", "yOffset", "cutoffY", "headTargetY", "shadowOpacity", "shadowDistance", "brightness", "contrast"];
        assertAllowedKeys(requirePlainObject(value, label), fields, label);
        validateOptionalRange(value, "scale", 0.75, 2.25, label);
        validateOptionalRange(value, "xOffset", -300, 300, label);
        validateOptionalRange(value, "yOffset", -250, 250, label);
        validateOptionalRange(value, "cutoffY", 700, 950, label);
        validateOptionalRange(value, "headTargetY", 100, 500, label);
        validateOptionalRange(value, "shadowOpacity", 0, 60, label);
        validateOptionalRange(value, "shadowDistance", 0, 40, label);
        validateOptionalRange(value, "brightness", -100, 100, label);
        validateOptionalRange(value, "contrast", -100, 100, label);
        if (own(value, "brightness") && Math.floor(Number(value.brightness)) !== Number(value.brightness)) throw new Error(label + ".brightness must be an integer.");
        if (own(value, "contrast") && Math.floor(Number(value.contrast)) !== Number(value.contrast)) throw new Error(label + ".contrast must be an integer.");
    }
    function validateEccwArtDirection(value, label) {
        label = label || "artDirection";
        assertAllowedKeys(requirePlainObject(value, label), ["competitorLeft", "competitorRight", "nameplates", "topPlate", "vs"], label);
        if (own(value, "competitorLeft")) validateEccwCompetitorDirection(value.competitorLeft, label + ".competitorLeft");
        if (own(value, "competitorRight")) validateEccwCompetitorDirection(value.competitorRight, label + ".competitorRight");
        if (own(value, "nameplates")) {
            var nameplates = value.nameplates;
            assertAllowedKeys(requirePlainObject(nameplates, label + ".nameplates"), [
                "targetWidthOccupancy", "targetHeightOccupancy", "minimumHorizontalPadding",
                "maximumFontSize", "minimumFontSize", "tracking"
            ], label + ".nameplates");
            validateOptionalRange(nameplates, "targetWidthOccupancy", 0.5, 0.95, label + ".nameplates");
            validateOptionalRange(nameplates, "targetHeightOccupancy", 0.3, 0.9, label + ".nameplates");
            validateOptionalRange(nameplates, "minimumHorizontalPadding", 20, 120, label + ".nameplates");
            validateOptionalRange(nameplates, "maximumFontSize", 36, 120, label + ".nameplates");
            validateOptionalRange(nameplates, "minimumFontSize", 18, 96, label + ".nameplates");
            validateOptionalRange(nameplates, "tracking", -100, 300, label + ".nameplates");
            if (own(nameplates, "minimumFontSize") && own(nameplates, "maximumFontSize") && Number(nameplates.minimumFontSize) > Number(nameplates.maximumFontSize)) {
                throw new Error(label + ".nameplates.minimumFontSize must not exceed maximumFontSize.");
            }
        }
        if (own(value, "topPlate")) {
            var topPlate = value.topPlate;
            assertAllowedKeys(requirePlainObject(topPlate, label + ".topPlate"), ["logo", "date", "stipulation"], label + ".topPlate");
            if (own(topPlate, "logo")) {
                assertAllowedKeys(requirePlainObject(topPlate.logo, label + ".topPlate.logo"), ["visibleWidth", "xOffset", "yOffset"], label + ".topPlate.logo");
                validateOptionalRange(topPlate.logo, "visibleWidth", 160, 360, label + ".topPlate.logo");
                validateOptionalRange(topPlate.logo, "xOffset", -150, 150, label + ".topPlate.logo");
                validateOptionalRange(topPlate.logo, "yOffset", -150, 150, label + ".topPlate.logo");
            }
            if (own(topPlate, "date")) validateEccwTopTextDirection(topPlate.date, label + ".topPlate.date", false);
            if (own(topPlate, "stipulation")) validateEccwTopTextDirection(topPlate.stipulation, label + ".topPlate.stipulation", true);
        }
        if (own(value, "vs")) {
            assertAllowedKeys(requirePlainObject(value.vs, label + ".vs"), ["fontSize", "xOffset", "yOffset", "fill"], label + ".vs");
            validateOptionalRange(value.vs, "fontSize", 40, 100, label + ".vs");
            validateOptionalRange(value.vs, "xOffset", -150, 150, label + ".vs");
            validateOptionalRange(value.vs, "yOffset", -150, 150, label + ".vs");
            if (own(value.vs, "fill")) validateRgb(value.vs.fill, label + ".vs.fill");
        }
    }
    function mergeEccwDirection(defaults, override) {
        var result = cloneJsonValue(defaults), keys = ownKeys(override || {});
        for (var i = 0; i < keys.length; i++) result[keys[i]] = cloneJsonValue(override[keys[i]]);
        return result;
    }
    function validateResolvedEccwTopPlateSpacing(resolved) {
        var logo = resolved.topPlate.logo, date = resolved.topPlate.date, stipulation = resolved.topPlate.stipulation;
        var logoHeight = Number(logo.visibleWidth) * (1024 / 1500);
        var elements = [
            { role: "logo", top: 92 + Number(logo.yOffset) - logoHeight / 2, bottom: 92 + Number(logo.yOffset) + logoHeight / 2 },
            { role: "date", top: 208 + Number(date.yOffset) - Number(date.fontSize) * 0.325, bottom: 208 + Number(date.yOffset) + Number(date.fontSize) * 0.325 }
        ];
        if (own(stipulation, "text")) {
            elements.push({
                role: "stipulation",
                top: 250 + Number(stipulation.yOffset) - Number(stipulation.fontSize) * 0.325,
                bottom: 250 + Number(stipulation.yOffset) + Number(stipulation.fontSize) * 0.325
            });
        }
        for (var i = 0; i < elements.length; i++) {
            if (elements[i].top < 0 || elements[i].bottom > 270) throw new Error("artDirection topPlate " + elements[i].role + " is estimated to extend outside the ECCW plate.");
            if (i > 0 && elements[i].top < elements[i - 1].bottom + 2) throw new Error("artDirection topPlate elements are estimated to overlap.");
        }
    }
    function resolvedEccwArtDirection(requested) {
        requested = requested || {};
        validateEccwArtDirection(requested, "artDirection");
        var competitorDefaults = {
            scale: 1.4, xOffset: 0, yOffset: 0, cutoffY: 850, headTargetY: 150,
            shadowOpacity: 35, shadowDistance: 18
        };
        var nameplateDefaults = {
            targetWidthOccupancy: 0.82, targetHeightOccupancy: 0.60,
            minimumHorizontalPadding: 30, maximumFontSize: 84,
            minimumFontSize: 40, tracking: 0
        };
        var logoDefaults = { visibleWidth: 260, xOffset: 0, yOffset: 0 };
        var shadowDefaults = { enabled: true, opacity: 42, distance: 4, blur: 8 };
        var noStrokeDefaults = { enabled: false, color: { red: 255, green: 255, blue: 255 }, size: 0, opacity: 0 };
        var dateDefaults = {
            fontSize: 66, xOffset: 0, yOffset: 0,
            fill: { red: 255, green: 255, blue: 255 },
            stroke: cloneJsonValue(noStrokeDefaults), shadow: cloneJsonValue(shadowDefaults)
        };
        var stipulationDefaults = {
            fontSize: 30, xOffset: 0, yOffset: 0,
            fill: { red: 225, green: 225, blue: 225 },
            stroke: cloneJsonValue(noStrokeDefaults),
            shadow: { enabled: true, opacity: 35, distance: 3, blur: 6 }
        };
        var requestedTop = requested.topPlate || {};
        var date = mergeEccwDirection(dateDefaults, requestedTop.date || {});
        date.stroke = mergeEccwDirection(noStrokeDefaults, requestedTop.date && requestedTop.date.stroke ? requestedTop.date.stroke : {});
        date.shadow = mergeEccwDirection(shadowDefaults, requestedTop.date && requestedTop.date.shadow ? requestedTop.date.shadow : {});
        var stipulation = mergeEccwDirection(stipulationDefaults, requestedTop.stipulation || {});
        stipulation.stroke = mergeEccwDirection(noStrokeDefaults, requestedTop.stipulation && requestedTop.stipulation.stroke ? requestedTop.stipulation.stroke : {});
        stipulation.shadow = mergeEccwDirection(stipulationDefaults.shadow, requestedTop.stipulation && requestedTop.stipulation.shadow ? requestedTop.stipulation.shadow : {});
        if (!requestedTop.stipulation || !own(requestedTop.stipulation, "text")) {
            try { delete stipulation.text; } catch (_deleteResolvedStipulationTextError) {}
        }
        var resolved = {
            competitorLeft: mergeEccwDirection(competitorDefaults, requested.competitorLeft || {}),
            competitorRight: mergeEccwDirection(competitorDefaults, requested.competitorRight || {}),
            nameplates: mergeEccwDirection(nameplateDefaults, requested.nameplates || {}),
            topPlate: {
                logo: mergeEccwDirection(logoDefaults, requestedTop.logo || {}),
                date: date,
                stipulation: stipulation
            },
            vs: mergeEccwDirection({
                fontSize: 78,
                xOffset: 0,
                yOffset: 6,
                fill: resolveEccwVsFill(requested.vs && own(requested.vs, "fill") ? requested.vs.fill : null)
            }, requested.vs || {})
        };
        resolved.vs.fill = resolveEccwVsFill(resolved.vs.fill);
        if (resolved.nameplates.minimumFontSize > resolved.nameplates.maximumFontSize) throw new Error("Resolved nameplate minimumFontSize exceeds maximumFontSize.");
        validateResolvedEccwTopPlateSpacing(resolved);
        return resolved;
    }
    function buildEccwVsFillDiagnostics(requested, resolved, runtime) {
        var requestedFill = requested && requested.vs && own(requested.vs, "fill") ?
            cloneJsonValue(requested.vs.fill) :
            null;
        return {
            requestedFill: requestedFill,
            presetDefaultFill: cloneJsonValue(ECCW_VS_APPROVED_FILL),
            finalResolvedFill: cloneJsonValue(resolved.vs.fill),
            appliedPhotoshopTextLayerFill: runtime && runtime.appliedPhotoshopTextLayerFill ?
                cloneJsonValue(runtime.appliedPhotoshopTextLayerFill) :
                null,
            measuredValidationFill: runtime && runtime.measuredValidationFill ?
                cloneJsonValue(runtime.measuredValidationFill) :
                null,
            validationPassed: runtime && typeof runtime.validationPassed === "boolean" ?
                runtime.validationPassed :
                null
        };
    }
    function validateVisibility(value) {
        if (!(value instanceof Array) || value.length < 1 || value.length > 40) throw new Error("changes.visibility must contain 1 through 40 entries.");
        var seen = {};
        for (var i = 0; i < value.length; i++) {
            var entry = requirePlainObject(value[i], "changes.visibility entry");
            assertAllowedKeys(entry, ["role", "visible"], "changes.visibility entry");
            if (!valueInList(entry.role, MATCH_VISIBILITY_ROLES)) throw new Error("Unsupported visibility role: " + entry.role);
            if (seen[entry.role]) throw new Error("Duplicate visibility role: " + entry.role);
            if (typeof entry.visible !== "boolean") throw new Error("Visibility values must be boolean.");
            seen[entry.role] = true;
        }
    }
    function validateCreateMatchCardPayload(payload) {
        var allowed = ["briefName", "canvas", "templateBackground", "style", "assets", "text", "placements", "artDirection", "outputPsdName", "outputPreviewName", "outputManifestName"];
        assertAllowedKeys(requirePlainObject(payload, "createMatchCard payload"), allowed, "createMatchCard payload");
        requireString(payload.briefName, "briefName", 1, 200, false);
        validateCanvas(payload.canvas);
        validateTemplateBackground(payload.templateBackground);
        validateCreateStyle(payload.style);
        validateAssetMap(payload.assets, "assets", true);
        if (
            payload.style.layoutPreset === "two-competitor-title-center" ||
            payload.style.layoutPreset === "two-competitor-title-lower" ||
            payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET
        ) {
            if (!own(payload.assets, "competitorLeft") || !own(payload.assets, "competitorRight")) throw new Error("The selected two-competitor layout requires competitorLeft and competitorRight assets.");
        } else if (payload.style.layoutPreset === "three-competitor-title-center") {
            if (!own(payload.assets, "competitorLeft") || !own(payload.assets, "competitorCenter") || !own(payload.assets, "competitorRight")) throw new Error("The selected three-competitor layout requires left, center, and right competitor assets.");
        } else if (payload.style.layoutPreset === "single-competitor-title-side" && !own(payload.assets, "competitorCenter")) {
            throw new Error("The selected single-competitor layout requires competitorCenter.");
        }
        validateTextMap(payload.text, "text");
        if (payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            if (own(payload, "artDirection")) validateEccwArtDirection(payload.artDirection, "artDirection");
            if (Number(payload.canvas.width) !== ECCW_PANEL_CANVAS_WIDTH || Number(payload.canvas.height) !== ECCW_PANEL_CANVAS_HEIGHT) {
                throw new Error("The ECCW panel template preset requires an exact 1920x1080 canvas.");
            }
            if (String(payload.templateBackground.fileName).toLowerCase() !== ECCW_PANEL_TEMPLATE_FILE_NAME.toLowerCase()) {
                throw new Error("The ECCW panel template preset requires its dedicated template background filename.");
            }
            var eccwAssetRoles = ownKeys(payload.assets), allowedEccwAssets = ["competitorLeft", "competitorRight", "showLogo"];
            for (var eccwAssetIndex = 0; eccwAssetIndex < eccwAssetRoles.length; eccwAssetIndex++) {
                if (!valueInList(eccwAssetRoles[eccwAssetIndex], allowedEccwAssets)) throw new Error("The ECCW panel template preset supports only competitorLeft, competitorRight, and showLogo assets.");
            }
            var requiredEccwText = ["competitorLeftName", "competitorRightName", "matchTitle", "date"];
            var eccwTextRoles = ownKeys(payload.text);
            for (var requiredTextIndex = 0; requiredTextIndex < requiredEccwText.length; requiredTextIndex++) {
                if (!own(payload.text, requiredEccwText[requiredTextIndex])) throw new Error("The ECCW panel template preset requires text." + requiredEccwText[requiredTextIndex] + ".");
            }
            for (var eccwTextIndex = 0; eccwTextIndex < eccwTextRoles.length; eccwTextIndex++) {
                if (!valueInList(eccwTextRoles[eccwTextIndex], requiredEccwText)) throw new Error("The ECCW panel template preset supports only the two competitor names, matchTitle, and date text.");
            }
            if (String(payload.text.matchTitle).replace(/^\s+|\s+$/g, "").toUpperCase() !== "VS") {
                throw new Error('The ECCW panel template preset requires text.matchTitle to be "VS".');
            }
        } else if (own(payload, "artDirection")) {
            throw new Error("artDirection is supported only by the ECCW panel template preset.");
        }
        if (own(payload, "placements")) {
            validatePlacements(payload.placements, "placements");
            var placementKeys = ownKeys(payload.placements);
            for (var placementIndex = 0; placementIndex < placementKeys.length; placementIndex++) {
                if (!own(payload.assets, placementKeys[placementIndex])) throw new Error("placements." + placementKeys[placementIndex] + " does not reference a supplied asset.");
            }
        }
        validateMatchOutputNames(payload);
        return payload;
    }
    function validateUpdateMatchCardPayload(payload) {
        var allowed = ["manifestFileName", "changes", "outputPsdName", "outputPreviewName", "outputManifestName"];
        assertAllowedKeys(requirePlainObject(payload, "updateMatchCard payload"), allowed, "updateMatchCard payload");
        validateMatchFileName(payload.manifestFileName, [".matchcard.json"], "manifestFileName");
        assertAllowedKeys(requirePlainObject(payload.changes, "changes"), ["templateBackground", "style", "assets", "text", "placements", "visibility"], "changes");
        var keys = ownKeys(payload.changes);
        if (!keys.length) throw new Error("changes must contain at least one update.");
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (key === "templateBackground") validateTemplateBackground(payload.changes[key]);
            else if (key === "style") validateUpdateStyle(payload.changes[key]);
            else if (key === "assets") validateAssetMap(payload.changes[key], "changes.assets", false);
            else if (key === "text") validateTextMap(payload.changes[key], "changes.text");
            else if (key === "placements") validatePlacements(payload.changes[key], "changes.placements");
            else if (key === "visibility") validateVisibility(payload.changes[key]);
        }
        validateMatchOutputNames(payload);
        if (payload.manifestFileName.toLowerCase() === payload.outputManifestName.toLowerCase()) throw new Error("The update manifest output must use a new filename.");
        return payload;
    }

    function configuredBaleCc(input, required) {
        var packageFile = own(input, "baleCcPackageFile") ? String(input.baleCcPackageFile) : "";
        var groupName = own(input, "baleCcGroupName") ? String(input.baleCcGroupName) : "";
        if (!packageFile || !groupName) {
            if (required) throw new Error("BALE_CC_PACKAGE_FILE and BALE_CC_GROUP_NAME are required in the local agent configuration.");
            return { configured: false, packageFileName: packageFile || null, groupName: groupName || null };
        }
        validateMatchFileName(packageFile, [".psd"], "Configured Bale CC package filename");
        requireString(groupName, "Configured Bale CC group name", 1, 255, false);
        return { configured: true, packageFileName: packageFile, groupName: groupName };
    }
    function matchWorkingFolder(input) {
        if (!own(input, "workingFolder") || typeof input.workingFolder !== "string") throw new Error("The trusted working folder was not supplied by the local agent.");
        var folder = new Folder(input.workingFolder);
        if (!folder.exists) throw new Error("The configured working folder does not exist.");
        return folder;
    }
    function findOpenDocumentForFile(file) {
        var wanted = String(file.fsName).toLowerCase();
        for (var i = 0; i < app.documents.length; i++) {
            try {
                if (String(app.documents[i].fullName.fsName).toLowerCase() === wanted) return app.documents[i];
            } catch (_unsavedDocumentError) {}
        }
        return null;
    }
    function currentDocumentOrNull() {
        try { return app.documents.length ? app.activeDocument : null; } catch (_activeError) { return null; }
    }
    function restoreActiveDocument(document) {
        if (!document) return;
        try { app.activeDocument = document; } catch (_restoreError) {}
    }
    function fileImageDimensions(file) {
        var previous = currentDocumentOrNull(), document = null, ownedDocument = false;
        var previousDialogs = null;
        try { previousDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO; } catch (_dialogReadError) {}
        try {
            document = findOpenDocumentForFile(file);
            if (!document) { document = app.open(file); ownedDocument = true; }
            return { width: toPixels(document.width), height: toPixels(document.height) };
        } catch (_metadataError) {
            return { width: null, height: null };
        } finally {
            if (ownedDocument && document) {
                try { document.close(SaveOptions.DONOTSAVECHANGES); } catch (_metadataCloseError) {}
            }
            if (previousDialogs !== null) try { app.displayDialogs = previousDialogs; } catch (_dialogRestoreError) {}
            restoreActiveDocument(previous);
        }
    }
    function suggestedMatchAssetRole(fileName, baleCc) {
        var lower = String(fileName).toLowerCase(), stem = lower.replace(/\.[^.]+$/, "");
        if (baleCc.configured && lower === baleCc.packageFileName.toLowerCase()) return "baleCcPackage";
        if (/(^|[_ .-])(template|background|templatebg|template_bg|bg)([_ .-]|$)/.test(stem)) return "templateBackground";
        if (/(^|[_ .-])(competitor|render|character)[_ .-]*left([_ .-]|$)|(^|[_ .-])left[_ .-]*(competitor|render|character)([_ .-]|$)/.test(stem)) return "competitorLeft";
        if (/(^|[_ .-])(competitor|render|character)[_ .-]*right([_ .-]|$)|(^|[_ .-])right[_ .-]*(competitor|render|character)([_ .-]|$)/.test(stem)) return "competitorRight";
        if (/(^|[_ .-])(competitor|render|character)[_ .-]*(center|centre)([_ .-]|$)|(^|[_ .-])(center|centre)[_ .-]*(competitor|render|character)([_ .-]|$)/.test(stem)) return "competitorCenter";
        if (/(championship[_ .-]*logo|title[_ .-]*logo)/.test(stem)) return "championshipLogo";
        if (/(^|[_ .-])(belt|titlebelt|championshipbelt|title)([_ .-]|$)/.test(stem)) return "beltImage";
        if (/(venue|arena)[_ .-]*logo/.test(stem)) return "venueLogo";
        if (/sponsor[_ .-]*logo/.test(stem)) return "sponsorLogo";
        if (/promotion[_ .-]*logo/.test(stem)) return "promotionLogo";
        if (/(show|event)[_ .-]*logo/.test(stem) || /(^|[_ .-])eccw([_ .-]|$)/.test(stem)) return "showLogo";
        if (/(photo|photograph)/.test(stem)) return "suppliedPhotograph";
        if (/(character|render)/.test(stem)) return "suppliedCharacterArtwork";
        return null;
    }
    function listMatchCardAssets(input) {
        var payload = input.payload || {};
        assertAllowedKeys(requirePlainObject(payload, "listMatchCardAssets payload"), [], "listMatchCardAssets payload");
        var folder = matchWorkingFolder(input), baleCc = configuredBaleCc(input, false);
        var entries = folder.getFiles(), files = [], i;
        for (i = 0; i < entries.length; i++) {
            if (!(entries[i] instanceof File)) continue;
            var extension = fileExtension(entries[i].name);
            if (valueInList(extension, MATCH_SUPPORTED_INPUT_EXTENSIONS)) files.push(entries[i]);
        }
        files.sort(function (left, right) {
            var a = String(left.name).toLowerCase(), b = String(right.name).toLowerCase();
            return a < b ? -1 : (a > b ? 1 : 0);
        });
        var assets = [];
        for (i = 0; i < files.length; i++) {
            var dimensions = fileImageDimensions(files[i]);
            var ext = fileExtension(files[i].name), suggestedRole = suggestedMatchAssetRole(files[i].name, baleCc);
            var raster = ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".tif" || ext === ".tiff";
            assets.push({
                fileName: files[i].name,
                extension: ext,
                fileSizeBytes: Number(files[i].length),
                width: dimensions.width,
                height: dimensions.height,
                isPsd: ext === ".psd",
                isPngOrJpeg: ext === ".png" || ext === ".jpg" || ext === ".jpeg",
                suggestedRole: suggestedRole,
                matchesConfiguredBaleCcPackage: baleCc.configured && String(files[i].name).toLowerCase() === baleCc.packageFileName.toLowerCase(),
                appearsSuitableAsTemplateBackground: ext === ".png" && suggestedRole === "templateBackground"
            });
        }
        return {
            assets: assets,
            baleCcConfigured: baleCc.configured,
            baleCcPackageFileName: baleCc.packageFileName,
            supportedExtensions: MATCH_SUPPORTED_INPUT_EXTENSIONS.slice(0),
            recursive: false
        };
    }
    function findNamedGroups(layers, groupName, matches) {
        for (var i = 0; i < layers.length; i++) {
            if (layers[i].typename === "LayerSet") {
                if (layers[i].name === groupName) matches.push(layers[i]);
                findNamedGroups(layers[i].layers, groupName, matches);
            }
        }
    }
    function inspectBaleCcPackage(input) {
        var baleCc = configuredBaleCc(input, false);
        var result = {
            configured: baleCc.configured,
            packageFileName: baleCc.packageFileName,
            groupName: baleCc.groupName,
            packageExists: false,
            matchingGroupCount: 0,
            available: false,
            issue: null
        };
        if (!baleCc.configured) {
            result.issue = "BALE_CC_PACKAGE_FILE and BALE_CC_GROUP_NAME are not fully configured in the local agent.";
            return result;
        }
        var folder = matchWorkingFolder(input), packageFile = childFile(folder, baleCc.packageFileName);
        result.packageExists = packageFile.exists;
        if (!packageFile.exists) {
            result.issue = "Missing Bale CC package: " + baleCc.packageFileName;
            return result;
        }
        var previous = currentDocumentOrNull(), document = null, ownedDocument = false, previousDialogs = null;
        try { previousDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO; } catch (_baleDialogReadError) {}
        try {
            document = findOpenDocumentForFile(packageFile);
            if (!document) { document = app.open(packageFile); ownedDocument = true; }
            else if (!document.saved) {
                result.issue = "The Bale CC package is open with unsaved changes; save or close it before running this job.";
                return result;
            }
            var matches = [];
            findNamedGroups(document.layers, baleCc.groupName, matches);
            result.matchingGroupCount = matches.length;
            result.available = matches.length === 1;
            if (!result.available) result.issue = "Expected exactly one Bale CC group named \"" + baleCc.groupName + "\"; found " + matches.length + ".";
        } catch (error) {
            result.issue = "Could not inspect Bale CC package: " + error.message;
        } finally {
            if (ownedDocument && document) try { document.close(SaveOptions.DONOTSAVECHANGES); } catch (_baleCloseError) {}
            if (previousDialogs !== null) try { app.displayDialogs = previousDialogs; } catch (_baleDialogRestoreError) {}
            restoreActiveDocument(previous);
        }
        return result;
    }
    function pushUniqueString(list, value) {
        for (var i = 0; i < list.length; i++) if (String(list[i]).toLowerCase() === String(value).toLowerCase()) return;
        list.push(value);
    }
    function preflightCreateMatchCard(input, payload) {
        var folder = matchWorkingFolder(input), missing = [], existingOutputs = [], requiredFiles = [];
        requiredFiles.push(payload.templateBackground.fileName);
        var assetKeys = ownKeys(payload.assets), i;
        for (i = 0; i < assetKeys.length; i++) requiredFiles.push(payload.assets[assetKeys[i]]);
        var bale = configuredBaleCc(input, false);
        if (bale.configured) requiredFiles.push(bale.packageFileName);
        for (i = 0; i < requiredFiles.length; i++) if (!childFile(folder, requiredFiles[i]).exists) pushUniqueString(missing, requiredFiles[i]);
        var outputs = [payload.outputPsdName, payload.outputPreviewName, payload.outputManifestName];
        for (i = 0; i < outputs.length; i++) if (childFile(folder, outputs[i]).exists) existingOutputs.push(outputs[i]);
        var baleStatus = inspectBaleCcPackage(input);
        return {
            ready: missing.length === 0 && existingOutputs.length === 0 && baleStatus.available,
            missingFiles: missing,
            existingOutputs: existingOutputs,
            baleCc: baleStatus
        };
    }
    function plannedMatchCardGroups(layoutPreset) {
        if (layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            return [
                "00 - BALE CC", "10 - TEMPLATE BACKGROUND", "40 - COMPETITOR RENDERS",
                "80 - SHOW LOGO", "60 - MATCH TITLE", "70 - EVENT INFORMATION"
            ];
        }
        return [
            "00 - BALE CC", "10 - TEMPLATE BACKGROUND", "20 - ATMOSPHERE",
            "30 - FRAMES AND PANELS", "40 - COMPETITOR RENDERS",
            "50 - CHAMPIONSHIP AND BELT", "60 - MATCH TITLE",
            "70 - EVENT INFORMATION", "80 - SHOW LOGO", "90 - FINISHING EFFECTS"
        ];
    }
    function plannedTextMappings(text) {
        var names = {
            championship: "CHAMPIONSHIP LABEL", competitorLeftName: "COMPETITOR LEFT NAME",
            competitorRightName: "COMPETITOR RIGHT NAME", competitorCenterName: "COMPETITOR CENTER NAME",
            matchTitle: "MAIN MATCH TITLE", stipulation: "MATCH STIPULATION", date: "EVENT DATE",
            time: "EVENT TIME", venue: "EVENT VENUE"
        };
        var result = [], keys = ownKeys(text);
        for (var i = 0; i < keys.length; i++) result.push({ role: keys[i], layerName: names[keys[i]], value: text[keys[i]] });
        return result;
    }
    function planMatchCard(input) {
        var payload = validateCreateMatchCardPayload(input.payload || {});
        var preflight = preflightCreateMatchCard(input, payload);
        var requestedArtDirection = payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && own(payload, "artDirection") ? cloneJsonValue(payload.artDirection) : null;
        var resolvedArtDirection = payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET ? resolvedEccwArtDirection(payload.artDirection || {}) : null;
        var plannedRequestedArtDirection = resolvedArtDirection ? cloneJsonValue(requestedArtDirection || {}) : null;
        if (plannedRequestedArtDirection) {
            if (!own(plannedRequestedArtDirection, "vs")) plannedRequestedArtDirection.vs = {};
            if (!own(plannedRequestedArtDirection.vs, "fill")) plannedRequestedArtDirection.vs.fill = null;
        }
        var plannedText = cloneJsonValue(payload.text);
        if (resolvedArtDirection && own(resolvedArtDirection.topPlate.stipulation, "text")) {
            plannedText.stipulation = resolvedArtDirection.topPlate.stipulation.text;
        }
        return {
            ready: preflight.ready,
            missingFiles: preflight.missingFiles,
            existingOutputs: preflight.existingOutputs,
            baleCc: preflight.baleCc,
            plannedLayerGroups: plannedMatchCardGroups(payload.style.layoutPreset),
            textMappings: plannedTextMappings(plannedText),
            assetMappings: payload.assets,
            templateBackground: payload.templateBackground,
            artDirection: resolvedArtDirection ? {
                requested: plannedRequestedArtDirection,
                resolved: resolvedArtDirection,
                vsFill: buildEccwVsFillDiagnostics(requestedArtDirection || {}, resolvedArtDirection, null)
            } : null,
            outputPsdName: payload.outputPsdName,
            outputPreviewName: payload.outputPreviewName,
            outputManifestName: payload.outputManifestName,
            performsPhotoshopWrite: false
        };
    }

    var MATCH_ASSET_LAYER_NAMES = {
        competitorLeft: "COMPETITOR LEFT - SMART OBJECT",
        competitorRight: "COMPETITOR RIGHT - SMART OBJECT",
        competitorCenter: "COMPETITOR CENTER - SMART OBJECT",
        showLogo: "SHOW LOGO - SMART OBJECT",
        promotionLogo: "PROMOTION LOGO - SMART OBJECT",
        championshipLogo: "CHAMPIONSHIP LOGO - SMART OBJECT",
        beltImage: "CHAMPIONSHIP BELT - SMART OBJECT",
        sponsorLogo: "SPONSOR LOGO - SMART OBJECT",
        venueLogo: "VENUE LOGO - SMART OBJECT",
        suppliedCharacterArtwork: "SUPPLIED CHARACTER ARTWORK - SMART OBJECT",
        suppliedPhotograph: "SUPPLIED PHOTOGRAPH - SMART OBJECT"
    };
    var MATCH_TEXT_LAYER_NAMES = {
        championship: "CHAMPIONSHIP LABEL",
        competitorLeftName: "COMPETITOR LEFT NAME",
        competitorRightName: "COMPETITOR RIGHT NAME",
        competitorCenterName: "COMPETITOR CENTER NAME",
        matchTitle: "MAIN MATCH TITLE",
        stipulation: "MATCH STIPULATION",
        date: "EVENT DATE",
        time: "EVENT TIME",
        venue: "EVENT VENUE"
    };
    var MATCH_GROUP_DEFINITIONS = [
        { role: "templateBackground", name: "10 - TEMPLATE BACKGROUND" },
        { role: "atmosphere", name: "20 - ATMOSPHERE" },
        { role: "framesAndPanels", name: "30 - FRAMES AND PANELS" },
        { role: "competitorRenders", name: "40 - COMPETITOR RENDERS" },
        { role: "championshipAndBelt", name: "50 - CHAMPIONSHIP AND BELT" },
        { role: "matchTitleGroup", name: "60 - MATCH TITLE" },
        { role: "eventInformation", name: "70 - EVENT INFORMATION" },
        { role: "showLogoGroup", name: "80 - SHOW LOGO" },
        { role: "finishingEffects", name: "90 - FINISHING EFFECTS" }
    ];
    function groupForAssetRole(groups, role) {
        if (role === "competitorLeft" || role === "competitorRight" || role === "competitorCenter" || role === "suppliedCharacterArtwork" || role === "suppliedPhotograph") return groups.competitorRenders;
        if (role === "beltImage" || role === "championshipLogo") return groups.championshipAndBelt;
        if (role === "showLogo" || role === "promotionLogo") return groups.showLogoGroup;
        if (role === "venueLogo" || role === "sponsorLogo") return groups.eventInformation;
        return groups.competitorRenders;
    }
    function createMatchCardGroups(document, layoutPreset) {
        var groups = {};
        var definitions = MATCH_GROUP_DEFINITIONS;
        if (layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            // Photoshop inserts every new group at the top. This creation order
            // produces the required bottom-to-top stack:
            // template, competitors, logo, live match text, live event text.
            definitions = [
                MATCH_GROUP_DEFINITIONS[0],
                MATCH_GROUP_DEFINITIONS[3],
                MATCH_GROUP_DEFINITIONS[7],
                MATCH_GROUP_DEFINITIONS[5],
                MATCH_GROUP_DEFINITIONS[6]
            ];
        }
        // Photoshop inserts new groups at the top. Creating 10 through 90
        // therefore leaves finishing overlays above the opaque background.
        for (var i = 0; i < definitions.length; i++) {
            var group = document.layerSets.add();
            group.name = definitions[i].name;
            groups[definitions[i].role] = group;
        }
        return groups;
    }
    function ensureEccwGroupOrder(document, groups) {
        app.activeDocument = document;
        groups.showLogoGroup.move(groups.competitorRenders, ElementPlacement.PLACEBEFORE);
        groups.matchTitleGroup.move(groups.showLogoGroup, ElementPlacement.PLACEBEFORE);
        groups.eventInformation.move(groups.matchTitleGroup, ElementPlacement.PLACEBEFORE);
    }
    function createRectangleFill(document, group, name, bounds, color, opacity, blendMode) {
        app.activeDocument = document;
        var makeDescriptor = new ActionDescriptor(), makeReference = new ActionReference();
        makeReference.putClass(stringIDToTypeID("contentLayer"));
        makeDescriptor.putReference(charIDToTypeID("null"), makeReference);
        var contentDescriptor = new ActionDescriptor(), colorLayerDescriptor = new ActionDescriptor(), colorDescriptor = new ActionDescriptor();
        colorDescriptor.putDouble(charIDToTypeID("Rd  "), Number(color.red));
        colorDescriptor.putDouble(charIDToTypeID("Grn "), Number(color.green));
        colorDescriptor.putDouble(charIDToTypeID("Bl  "), Number(color.blue));
        colorLayerDescriptor.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), colorDescriptor);
        contentDescriptor.putObject(charIDToTypeID("Type"), stringIDToTypeID("solidColorLayer"), colorLayerDescriptor);
        var rectangleDescriptor = new ActionDescriptor();
        rectangleDescriptor.putUnitDouble(charIDToTypeID("Top "), charIDToTypeID("#Pxl"), Number(bounds.top));
        rectangleDescriptor.putUnitDouble(charIDToTypeID("Left"), charIDToTypeID("#Pxl"), Number(bounds.left));
        rectangleDescriptor.putUnitDouble(charIDToTypeID("Btom"), charIDToTypeID("#Pxl"), Number(bounds.bottom));
        rectangleDescriptor.putUnitDouble(charIDToTypeID("Rght"), charIDToTypeID("#Pxl"), Number(bounds.right));
        contentDescriptor.putObject(charIDToTypeID("Shp "), charIDToTypeID("Rctn"), rectangleDescriptor);
        makeDescriptor.putObject(charIDToTypeID("Usng"), stringIDToTypeID("contentLayer"), contentDescriptor);
        executeAction(charIDToTypeID("Mk  "), makeDescriptor, DialogModes.NO);
        var layer = document.activeLayer;
        layer.name = name;
        if (typeof opacity !== "undefined") layer.opacity = Number(opacity);
        try {
            if (blendMode === "screen") layer.blendMode = BlendMode.SCREEN;
            else if (blendMode === "multiply") layer.blendMode = BlendMode.MULTIPLY;
            else layer.blendMode = BlendMode.NORMAL;
        } catch (_shapeBlendError) {}
        layer.move(group, ElementPlacement.INSIDE);
        document.activeLayer = layer;
        return layer;
    }
    function setActiveSolidFillColor(color) {
        var setDescriptor = new ActionDescriptor(), reference = new ActionReference();
        reference.putEnumerated(stringIDToTypeID("contentLayer"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        setDescriptor.putReference(charIDToTypeID("null"), reference);
        var solidDescriptor = new ActionDescriptor(), colorDescriptor = new ActionDescriptor();
        colorDescriptor.putDouble(charIDToTypeID("Rd  "), Number(color.red));
        colorDescriptor.putDouble(charIDToTypeID("Grn "), Number(color.green));
        colorDescriptor.putDouble(charIDToTypeID("Bl  "), Number(color.blue));
        solidDescriptor.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), colorDescriptor);
        setDescriptor.putObject(charIDToTypeID("T   "), stringIDToTypeID("solidColorLayer"), solidDescriptor);
        executeAction(charIDToTypeID("setd"), setDescriptor, DialogModes.NO);
    }
    function createProceduralMatchLayers(document, groups, style, semantic) {
        if (style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            // The dedicated ECCW PNG already contains every finished plate,
            // divider, border, and panel. Keep the semantic groups empty so
            // manifest/update compatibility is preserved without adding art.
            return;
        }
        var width = toPixels(document.width), height = toPixels(document.height);
        var titleBounds = { left: width * 0.28, top: height * 0.48, right: width * 0.72, bottom: height * 0.68 };
        if (style.layoutPreset === "two-competitor-title-lower") titleBounds = { left: width * 0.22, top: height * 0.61, right: width * 0.78, bottom: height * 0.77 };
        else if (style.layoutPreset === "three-competitor-title-center") titleBounds = { left: width * 0.3, top: height * 0.46, right: width * 0.7, bottom: height * 0.66 };
        else if (style.layoutPreset === "single-competitor-title-side") titleBounds = { left: width * 0.5, top: height * 0.34, right: width * 0.94, bottom: height * 0.69 };
        semantic.fullFrameAtmosphere = createRectangleFill(document, groups.atmosphere, "FULL FRAME ATMOSPHERE", { left: 0, top: 0, right: width, bottom: height }, style.secondaryColor, 18, "multiply");
        semantic.lowerThirdPanel = createRectangleFill(document, groups.framesAndPanels, "LOWER THIRD PANEL", { left: 0, top: height * 0.77, right: width, bottom: height }, style.secondaryColor, 86, "normal");
        semantic.titleBacking = createRectangleFill(document, groups.framesAndPanels, "TITLE BACKING", titleBounds, style.primaryColor, 76, "normal");
        semantic.showLogoPlate = createRectangleFill(document, groups.framesAndPanels, "SHOW LOGO PLATE", { left: width * 0.36, top: height * 0.025, right: width * 0.64, bottom: height * 0.21 }, style.secondaryColor, 72, "normal");
        semantic.lowerLightStrip = createRectangleFill(document, groups.finishingEffects, "LOWER LIGHT STRIP", { left: 0, top: height * 0.765, right: width, bottom: height * 0.775 }, style.accentColor, 92, "screen");
        semantic.topBorder = createRectangleFill(document, groups.finishingEffects, "TOP BORDER", { left: 0, top: 0, right: width, bottom: Math.max(3, height * 0.009) }, style.metallicColor, 100, "normal");
        semantic.bottomBorder = createRectangleFill(document, groups.finishingEffects, "BOTTOM BORDER", { left: 0, top: height - Math.max(3, height * 0.012), right: width, bottom: height }, style.metallicColor, 100, "normal");
        semantic.finishingGlow = createRectangleFill(document, groups.finishingEffects, "FINISHING GLOW", { left: width * 0.24, top: height * 0.43, right: width * 0.76, bottom: height * 0.73 }, style.accentColor, 13, "screen");
    }
    function placeFileAsSmartObject(document, file, group, layerName) {
        app.activeDocument = document;
        var descriptor = new ActionDescriptor();
        descriptor.putPath(charIDToTypeID("null"), file);
        descriptor.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
        executeAction(charIDToTypeID("Plc "), descriptor, DialogModes.NO);
        var layer = document.activeLayer;
        if (!isSmartObject(layer)) throw new Error("Photoshop did not place " + file.name + " as a Smart Object.");
        layer.name = layerName;
        layer.move(group, ElementPlacement.INSIDE);
        document.activeLayer = layer;
        return layer;
    }
    function defaultAssetBounds(role, width, height, layoutPreset) {
        if (role === "templateBackground") return { left: 0, top: 0, right: width, bottom: height };
        if (layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            if (role === "competitorLeft") return { left: 130, top: 240, right: 870, bottom: 845 };
            if (role === "competitorRight") return { left: 1050, top: 240, right: 1790, bottom: 845 };
            if (role === "showLogo") return { left: 810, top: 52.5, right: 1110, bottom: 157.5 };
        }
        if (layoutPreset === "single-competitor-title-side" && role === "competitorCenter") return { left: width * 0.015, top: height * 0.1, right: width * 0.56, bottom: height * 0.99 };
        if (layoutPreset === "three-competitor-title-center" && role === "competitorLeft") return { left: width * 0.005, top: height * 0.16, right: width * 0.4, bottom: height * 0.99 };
        if (layoutPreset === "three-competitor-title-center" && role === "competitorCenter") return { left: width * 0.27, top: height * 0.08, right: width * 0.73, bottom: height * 0.99 };
        if (layoutPreset === "three-competitor-title-center" && role === "competitorRight") return { left: width * 0.6, top: height * 0.16, right: width * 0.995, bottom: height * 0.99 };
        if (role === "competitorLeft") return { left: width * 0.015, top: height * 0.12, right: width * 0.53, bottom: height * 0.98 };
        if (role === "competitorRight") return { left: width * 0.47, top: height * 0.12, right: width * 0.985, bottom: height * 0.98 };
        if (role === "competitorCenter") return { left: width * 0.24, top: height * 0.1, right: width * 0.76, bottom: height * 0.98 };
        if (role === "showLogo" || role === "promotionLogo") return { left: width * 0.37, top: height * 0.04, right: width * 0.63, bottom: height * 0.2 };
        if (role === "beltImage" || role === "championshipLogo") return { left: width * 0.34, top: height * 0.45, right: width * 0.66, bottom: height * 0.74 };
        if (role === "venueLogo") return { left: width * 0.4, top: height * 0.82, right: width * 0.6, bottom: height * 0.96 };
        if (role === "sponsorLogo") return { left: width * 0.78, top: height * 0.82, right: width * 0.96, bottom: height * 0.96 };
        return { left: width * 0.18, top: height * 0.12, right: width * 0.82, bottom: height * 0.96 };
    }
    function applyLayerPlacement(document, layer, role, placement, defaultFitMode, layoutPreset) {
        var width = toPixels(document.width), height = toPixels(document.height), target = defaultAssetBounds(role, width, height, layoutPreset);
        var coordinateSpace = placement && own(placement, "coordinateSpace") ? placement.coordinateSpace : "normalized";
        if (placement && own(placement, "maxWidth")) {
            var maximumWidth = Number(placement.maxWidth) * (coordinateSpace === "normalized" ? width : 1);
            var centerX = (target.left + target.right) / 2;
            target.left = centerX - maximumWidth / 2; target.right = centerX + maximumWidth / 2;
        }
        if (placement && own(placement, "maxHeight")) {
            var maximumHeight = Number(placement.maxHeight) * (coordinateSpace === "normalized" ? height : 1);
            var centerY = (target.top + target.bottom) / 2;
            target.top = centerY - maximumHeight / 2; target.bottom = centerY + maximumHeight / 2;
        }
        var currentBounds = safeTransformBounds(layer);
        if (!currentBounds) throw new Error("Could not read placed bounds for " + role + ".");
        var current = rect(currentBounds), targetRect = rect(target);
        if (current.width <= 0 || current.height <= 0) throw new Error("Placed asset has empty bounds: " + role);
        var fitMode = placement && own(placement, "fitMode") ? placement.fitMode : defaultFitMode;
        if (fitMode !== "keep-transform") {
            var ratio = fitMode === "cover" ? Math.max(targetRect.width / current.width, targetRect.height / current.height) : Math.min(targetRect.width / current.width, targetRect.height / current.height);
            layer.resize(ratio * 100, ratio * 100, AnchorPosition.MIDDLECENTER);
        }
        if (placement && own(placement, "scale")) layer.resize(Number(placement.scale) * 100, Number(placement.scale) * 100, AnchorPosition.MIDDLECENTER);
        var movedBounds = safeTransformBounds(layer), desiredX = targetRect.centerX, desiredY = targetRect.centerY;
        if (!movedBounds) throw new Error("Could not read transformed bounds for " + role + ".");
        if (fitMode === "keep-transform" && (!placement || !own(placement, "x"))) {
            desiredX = current.centerX; desiredY = current.centerY;
        }
        if (placement && own(placement, "x")) {
            desiredX = Number(placement.x) * (coordinateSpace === "normalized" ? width : 1);
            desiredY = Number(placement.y) * (coordinateSpace === "normalized" ? height : 1);
        }
        layer.translate(UnitValue(desiredX - ((movedBounds.left + movedBounds.right) / 2), "px"), UnitValue(desiredY - ((movedBounds.top + movedBounds.bottom) / 2), "px"));
        var targetDeltaX = desiredX - targetRect.centerX, targetDeltaY = desiredY - targetRect.centerY;
        target.left += targetDeltaX; target.right += targetDeltaX; target.top += targetDeltaY; target.bottom += targetDeltaY;
        return target;
    }
    function placementTargetBounds(document, role, placement, layoutPreset) {
        var width = toPixels(document.width), height = toPixels(document.height), target = defaultAssetBounds(role, width, height, layoutPreset);
        var coordinateSpace = placement && own(placement, "coordinateSpace") ? placement.coordinateSpace : "normalized";
        if (placement && own(placement, "maxWidth")) {
            var maximumWidth = Number(placement.maxWidth) * (coordinateSpace === "normalized" ? width : 1), centerX = (target.left + target.right) / 2;
            target.left = centerX - maximumWidth / 2; target.right = centerX + maximumWidth / 2;
        }
        if (placement && own(placement, "maxHeight")) {
            var maximumHeight = Number(placement.maxHeight) * (coordinateSpace === "normalized" ? height : 1), centerY = (target.top + target.bottom) / 2;
            target.top = centerY - maximumHeight / 2; target.bottom = centerY + maximumHeight / 2;
        }
        if (placement && own(placement, "x")) {
            var desiredX = Number(placement.x) * (coordinateSpace === "normalized" ? width : 1), desiredY = Number(placement.y) * (coordinateSpace === "normalized" ? height : 1);
            var deltaX = desiredX - ((target.left + target.right) / 2), deltaY = desiredY - ((target.top + target.bottom) / 2);
            target.left += deltaX; target.right += deltaX; target.top += deltaY; target.bottom += deltaY;
        }
        return target;
    }
    function addSelectionMask(document, layer, bounds) {
        app.activeDocument = document; document.activeLayer = layer;
        document.selection.select([
            [UnitValue(bounds.left, "px"), UnitValue(bounds.top, "px")],
            [UnitValue(bounds.right, "px"), UnitValue(bounds.top, "px")],
            [UnitValue(bounds.right, "px"), UnitValue(bounds.bottom, "px")],
            [UnitValue(bounds.left, "px"), UnitValue(bounds.bottom, "px")]
        ]);
        try {
            var descriptor = new ActionDescriptor(), reference = new ActionReference();
            descriptor.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
            reference.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
            descriptor.putReference(charIDToTypeID("At  "), reference);
            descriptor.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), charIDToTypeID("RvlS"));
            executeAction(charIDToTypeID("Mk  "), descriptor, DialogModes.NO);
        } finally {
            try { document.selection.deselect(); } catch (_maskDeselectError) {}
        }
    }
    function layerHasUserMask(layer) {
        var layerId = safeLayerId(layer);
        if (!layerId) throw new Error("Cannot inspect a layer mask without a numeric layer ID.");
        var reference = new ActionReference();
        reference.putIdentifier(charIDToTypeID("Lyr "), layerId);
        var descriptor = executeActionGet(reference), key = stringIDToTypeID("hasUserMask");
        return descriptor.hasKey(key) && descriptor.getBoolean(key);
    }
    function activeUserMaskSelectionBounds(document, layer) {
        app.activeDocument = document;
        document.activeLayer = layer;
        var descriptor = new ActionDescriptor(), selectionReference = new ActionReference(), maskReference = new ActionReference();
        selectionReference.putProperty(charIDToTypeID("Chnl"), charIDToTypeID("fsel"));
        descriptor.putReference(charIDToTypeID("null"), selectionReference);
        maskReference.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
        descriptor.putReference(charIDToTypeID("T   "), maskReference);
        executeAction(charIDToTypeID("setd"), descriptor, DialogModes.NO);
        try {
            var bounds = document.selection.bounds;
            return {
                left: toPixels(bounds[0]),
                top: toPixels(bounds[1]),
                right: toPixels(bounds[2]),
                bottom: toPixels(bounds[3])
            };
        } finally {
            try { document.selection.deselect(); } catch (_eccwMaskSelectionDeselectError) {}
        }
    }
    function applyMandatoryEccwCutoffMask(document, layer, role, unmaskedBounds, cutoffY) {
        if (layerHasUserMask(layer)) throw new Error(role + " already has an unowned layer mask before ECCW cutoff masking.");
        if (!unmaskedBounds) throw new Error(role + " has no measurable alpha-visible bounds before ECCW cutoff masking.");
        addSelectionMask(document, layer, {
            left: 0,
            top: 0,
            right: ECCW_PANEL_CANVAS_WIDTH,
            bottom: cutoffY
        });
        if (!layerHasUserMask(layer)) throw new Error(role + " cutoff failed: Photoshop did not create a real user layer mask.");
        var revealBounds;
        try {
            revealBounds = activeUserMaskSelectionBounds(document, layer);
        } catch (error) {
            throw new Error(role + " cutoff failed while verifying the user mask: " + error.message);
        }
        var tolerance = 1;
        if (
            Math.abs(revealBounds.left) > tolerance ||
            Math.abs(revealBounds.top) > tolerance ||
            Math.abs(revealBounds.right - ECCW_PANEL_CANVAS_WIDTH) > tolerance ||
            Math.abs(revealBounds.bottom - cutoffY) > tolerance
        ) {
            throw new Error(role + " cutoff mask does not reveal exactly the canvas area above y=" + cutoffY + ".");
        }
    }
    function measureBoundsBehindEccwMask(document, layer, role, cutoffY) {
        var directBounds = safeBoundsWithoutMask(layer);
        if (directBounds) return directBounds;
        var unmaskedBounds = null, restoreError = null;
        deleteActiveUserMask(document, layer);
        try {
            unmaskedBounds = safeTransformBounds(layer);
        } finally {
            try {
                addSelectionMask(document, layer, {
                    left: 0,
                    top: 0,
                    right: ECCW_PANEL_CANVAS_WIDTH,
                    bottom: cutoffY
                });
            } catch (error) {
                restoreError = error;
            }
        }
        if (restoreError || !layerHasUserMask(layer)) {
            throw new Error(role + " cutoff validation could not restore the mandatory user mask: " + (restoreError ? restoreError.message : "mask is missing"));
        }
        var restoredRevealBounds = activeUserMaskSelectionBounds(document, layer);
        if (
            Math.abs(restoredRevealBounds.left) > 1 ||
            Math.abs(restoredRevealBounds.top) > 1 ||
            Math.abs(restoredRevealBounds.right - ECCW_PANEL_CANVAS_WIDTH) > 1 ||
            Math.abs(restoredRevealBounds.bottom - cutoffY) > 1
        ) {
            throw new Error(role + " cutoff validation restored an invalid user mask.");
        }
        if (!unmaskedBounds) throw new Error("Could not measure alpha-visible bounds behind the user mask for " + role + ".");
        return unmaskedBounds;
    }
    function findLayersNamed(layers, name, matches) {
        for (var i = 0; i < layers.length; i++) {
            if (layers[i].name === name) matches.push(layers[i]);
            if (layers[i].typename === "LayerSet") findLayersNamed(layers[i].layers, name, matches);
        }
    }
    function applyClippingPreference(document, layer, group, role, bounds, enabled, ownedBase) {
        var baseName = MATCH_ASSET_LAYER_NAMES[role] + " - CLIPPING BASE", base = ownedBase || null, directMatches = [];
        for (var directIndex = 0; directIndex < group.layers.length; directIndex++) if (group.layers[directIndex].name === baseName) directMatches.push(group.layers[directIndex]);
        if (!base && directMatches.length) throw new Error("A same-named clipping base exists without manifest ownership for " + role + ".");
        if (base) {
            if (directMatches.length !== 1 || safeLayerId(directMatches[0]) !== safeLayerId(base)) throw new Error("The manifest-owned clipping base for " + role + " is no longer a unique direct child.");
        }
        if (enabled) {
            if (!base && Boolean(layer.grouped)) throw new Error("The layer is clipped to an unowned base; refusing to replace an unrelated layer.");
            // Rebuild only a manifest-owned vector base so it follows changed
            // position/maximum bounds without touching unrelated layers.
            try { layer.grouped = false; } catch (_temporaryUnclipError) {}
            if (base) base.remove();
            base = createRectangleFill(document, group, baseName, bounds, { red: 0, green: 0, blue: 0 }, 100, "normal");
            base.move(layer, ElementPlacement.PLACEAFTER);
            document.activeLayer = layer;
            layer.grouped = true;
            if (!layer.grouped) throw new Error("Photoshop did not retain the clipping mask for " + role + ".");
        } else {
            if (!base && Boolean(layer.grouped)) throw new Error("The layer is clipped to an unowned base; refusing to remove an unrelated clipping relationship.");
            try { layer.grouped = false; } catch (_unclipError) {}
            if (base) base.remove();
            base = null;
        }
        return base;
    }
    function deleteActiveUserMask(document, layer) {
        app.activeDocument = document; document.activeLayer = layer;
        var descriptor = new ActionDescriptor(), reference = new ActionReference();
        reference.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
        descriptor.putReference(charIDToTypeID("null"), reference);
        executeAction(charIDToTypeID("Dlt "), descriptor, DialogModes.NO);
    }
    function applyNonGenerativeMaskPreference(document, layer, bounds, enabled, role, previouslyOwned, rebuildOwned) {
        var hasMask = layerHasUserMask(layer);
        if (enabled && !hasMask) addSelectionMask(document, layer, bounds);
        else if (enabled && hasMask && previouslyOwned && rebuildOwned) { deleteActiveUserMask(document, layer); addSelectionMask(document, layer, bounds); }
        else if (enabled && hasMask && !previouslyOwned) throw new Error("The existing mask for " + role + " is not manifest-owned; refusing to claim or replace it.");
        else if (!enabled && hasMask) {
            if (!previouslyOwned) throw new Error("Refusing to remove an unowned layer mask for " + role + ".");
            deleteActiveUserMask(document, layer);
        }
    }
    function setLayerEffectsForPlacement(document, layer, placement, accentColor) {
        if (!placement || (!own(placement, "dropShadow") && !own(placement, "outerGlow"))) return;
        app.activeDocument = document; document.activeLayer = layer;
        var effects = readPreservableLayerEffects();
        if (own(placement, "dropShadow") && placement.dropShadow) {
            var shadow = new ActionDescriptor(), black = new ActionDescriptor();
            shadow.putBoolean(charIDToTypeID("enab"), true);
            shadow.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Mltp"));
            shadow.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 55);
            shadow.putUnitDouble(charIDToTypeID("Dstn"), charIDToTypeID("#Pxl"), 18);
            shadow.putUnitDouble(charIDToTypeID("blur"), charIDToTypeID("#Pxl"), 28);
            black.putDouble(charIDToTypeID("Rd  "), 0); black.putDouble(charIDToTypeID("Grn "), 0); black.putDouble(charIDToTypeID("Bl  "), 0);
            shadow.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), black);
            effects.putObject(stringIDToTypeID("dropShadow"), stringIDToTypeID("dropShadow"), shadow);
        } else if (own(placement, "dropShadow") && effects.hasKey(stringIDToTypeID("dropShadow"))) effects.erase(stringIDToTypeID("dropShadow"));
        if (own(placement, "outerGlow") && placement.outerGlow) {
            var glow = new ActionDescriptor(), glowColor = new ActionDescriptor();
            glow.putBoolean(charIDToTypeID("enab"), true);
            glow.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Scrn"));
            glow.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 55);
            glow.putUnitDouble(charIDToTypeID("blur"), charIDToTypeID("#Pxl"), 24);
            glowColor.putDouble(charIDToTypeID("Rd  "), accentColor.red); glowColor.putDouble(charIDToTypeID("Grn "), accentColor.green); glowColor.putDouble(charIDToTypeID("Bl  "), accentColor.blue);
            glow.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), glowColor);
            effects.putObject(stringIDToTypeID("outerGlow"), stringIDToTypeID("outerGlow"), glow);
        } else if (own(placement, "outerGlow") && effects.hasKey(stringIDToTypeID("outerGlow"))) effects.erase(stringIDToTypeID("outerGlow"));
        var effectsScale = stringIDToTypeID("scale");
        if (!effects.hasKey(effectsScale)) effects.putUnitDouble(effectsScale, charIDToTypeID("#Prc"), 100);
        var setDescriptor = new ActionDescriptor(), setReference = new ActionReference();
        setReference.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("layerEffects"));
        setReference.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        setDescriptor.putReference(charIDToTypeID("null"), setReference);
        setDescriptor.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), effects);
        executeAction(charIDToTypeID("setd"), setDescriptor, DialogModes.NO);
    }
    function inspectCompetitorTransparencyBeforePlacement(file, role, warnings) {
        if (role !== "competitorLeft" && role !== "competitorRight") return;
        if (fileExtension(file.name) !== ".png") {
            warnings.push(role + " is not a PNG; source alpha could not be guaranteed and the asset may be opaque. No background fill was added.");
            return;
        }
        var previous = currentDocumentOrNull(), sourceDocument = null, ownedDocument = false, sourceLayer = null;
        try {
            sourceDocument = findOpenDocumentForFile(file);
            if (!sourceDocument) {
                sourceDocument = app.open(file);
                ownedDocument = true;
            }
            app.activeDocument = sourceDocument;
            if (!sourceDocument.layers.length) throw new Error("the source document has no layers");
            sourceLayer = sourceDocument.layers[0];
            var isOpaqueBackground = false;
            try { isOpaqueBackground = sourceDocument.layers.length === 1 && Boolean(sourceLayer.isBackgroundLayer); }
            catch (_competitorBackgroundInspectionError) {}
            if (isOpaqueBackground) {
                warnings.push(
                    role + ' source PNG "' + file.name +
                    '" is opaque in Photoshop and will remain opaque. No black fill or background layer was added.'
                );
            }
        } catch (error) {
            throw new Error("Could not inspect source PNG transparency for " + role + ": " + safeBaleStageErrorMessage(error));
        } finally {
            if (ownedDocument && sourceDocument) {
                try { sourceDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_competitorTransparencyCloseError) {}
            }
            restoreActiveDocument(previous);
        }
    }
    function inspectEccwLogoSourceAlphaGeometry(file) {
        var previous = currentDocumentOrNull(), sourceDocument = null, sourceOwned = false, analysisDocument = null;
        try {
            sourceDocument = findOpenDocumentForFile(file);
            if (!sourceDocument) {
                sourceDocument = app.open(file);
                sourceOwned = true;
            }
            app.activeDocument = sourceDocument;
            var sourceFullWidth = toPixels(sourceDocument.width);
            if (!isFinite(sourceFullWidth) || sourceFullWidth <= 0) throw new Error("source document width is invalid");
            analysisDocument = sourceDocument.duplicate("__ECCW_LOGO_ALPHA_INSPECTION__", true);
            app.activeDocument = analysisDocument;
            if (!analysisDocument.layers.length) throw new Error("source document has no visible layers");
            var analysisLayer = analysisDocument.layers[0], sourceBounds = null;
            try {
                if (Boolean(analysisLayer.isBackgroundLayer)) {
                    sourceBounds = { left: 0, top: 0, right: toPixels(analysisDocument.width), bottom: toPixels(analysisDocument.height) };
                }
            } catch (_logoBackgroundInspectionError) {}
            if (!sourceBounds) sourceBounds = activeLayerTransparencyBounds(analysisDocument, analysisLayer, "showLogo source");
            var sourceAlphaVisibleWidth = Number(sourceBounds.right) - Number(sourceBounds.left);
            if (!isFinite(sourceAlphaVisibleWidth) || sourceAlphaVisibleWidth <= 0) throw new Error("source alpha-visible width is empty");
            return {
                sourceFullWidth: sourceFullWidth,
                sourceAlphaVisibleWidth: sourceAlphaVisibleWidth
            };
        } catch (error) {
            throw new Error("Could not inspect showLogo source alpha geometry: " + safeBaleStageErrorMessage(error));
        } finally {
            if (analysisDocument) try { analysisDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_logoAnalysisCloseError) {}
            if (sourceOwned && sourceDocument) try { sourceDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_logoSourceCloseError) {}
            restoreActiveDocument(previous);
        }
    }
    function calculateEccwLogoScaleDiagnostics(sourceFullWidth, sourceAlphaVisibleWidth, requestedAlphaVisibleWidth, initialPlacedAlphaVisibleWidth, initialPlacementTransform, measuredWidthAfterNominalScale, correctionFactors, finalMeasuredAlphaVisibleWidth, verificationTolerance) {
        var values = [sourceFullWidth, sourceAlphaVisibleWidth, requestedAlphaVisibleWidth, initialPlacedAlphaVisibleWidth, measuredWidthAfterNominalScale, finalMeasuredAlphaVisibleWidth, verificationTolerance];
        for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
            if (!isFinite(Number(values[valueIndex])) || Number(values[valueIndex]) <= 0) throw new Error("ECCW logo scale diagnostics require positive finite measurements.");
        }
        if (!(correctionFactors instanceof Array)) throw new Error("ECCW logo correctionFactors must be an array.");
        var nominalScaleFactor = Number(requestedAlphaVisibleWidth) / Number(sourceAlphaVisibleWidth);
        var cumulativeAppliedScaleFactor = nominalScaleFactor;
        var normalizedCorrectionFactors = [];
        for (var correctionIndex = 0; correctionIndex < correctionFactors.length; correctionIndex++) {
            var correctionFactor = Number(correctionFactors[correctionIndex]);
            if (!isFinite(correctionFactor) || correctionFactor <= 0) throw new Error("ECCW logo correctionFactors must contain positive finite values.");
            normalizedCorrectionFactors.push(correctionFactor);
            cumulativeAppliedScaleFactor *= correctionFactor;
        }
        var finalMeasured = Number(finalMeasuredAlphaVisibleWidth);
        var difference = Math.abs(finalMeasured - Number(requestedAlphaVisibleWidth));
        return {
            sourceFullWidth: Number(sourceFullWidth),
            sourceAlphaVisibleWidth: Number(sourceAlphaVisibleWidth),
            requestedAlphaVisibleWidth: Number(requestedAlphaVisibleWidth),
            initialPlacedAlphaVisibleWidth: Number(initialPlacedAlphaVisibleWidth),
            initialPlacementTransform: initialPlacementTransform instanceof Array ? initialPlacementTransform.slice(0) : null,
            nominalScaleFactor: nominalScaleFactor,
            nominalScalePercent: nominalScaleFactor * 100,
            measuredWidthAfterNominalScale: Number(measuredWidthAfterNominalScale),
            correctionFactors: normalizedCorrectionFactors,
            correctionIterations: normalizedCorrectionFactors.length,
            cumulativeAppliedScaleFactor: cumulativeAppliedScaleFactor,
            finalMeasuredAlphaVisibleWidth: finalMeasured,
            difference: difference,
            tolerance: Number(verificationTolerance),
            verificationPassed: difference <= Number(verificationTolerance),
            scaleAnchor: "MIDDLECENTER",
            postScaleContainmentOrNormalization: []
        };
    }
    function formatEccwLogoWidthVerificationFailure(diagnostics) {
        return "showLogo alpha-visible width verification failed: expected=" +
            Number(diagnostics.requestedAlphaVisibleWidth).toFixed(4) + "px, measured=" +
            Number(diagnostics.finalMeasuredAlphaVisibleWidth).toFixed(4) + "px, sourceAlpha=" +
            Number(diagnostics.sourceAlphaVisibleWidth).toFixed(4) + "px, sourceFull=" +
            Number(diagnostics.sourceFullWidth).toFixed(4) + "px, initialPlacedAlpha=" +
            Number(diagnostics.initialPlacedAlphaVisibleWidth).toFixed(4) + "px, initialPlacementTransform=" +
            (diagnostics.initialPlacementTransform ? "[" + diagnostics.initialPlacementTransform.join(",") + "]" : "unavailable") +
            ", nominalScaleFactor=" + Number(diagnostics.nominalScaleFactor).toFixed(8) +
            ", nominalScalePercent=" + Number(diagnostics.nominalScalePercent).toFixed(4) +
            "%, measuredAfterNominal=" + Number(diagnostics.measuredWidthAfterNominalScale).toFixed(4) +
            "px, correctionFactors=[" + diagnostics.correctionFactors.join(",") +
            "], correctionIterations=" + diagnostics.correctionIterations +
            ", cumulativeAppliedScaleFactor=" + Number(diagnostics.cumulativeAppliedScaleFactor).toFixed(8) +
            ", difference=" + Number(diagnostics.difference).toFixed(4) +
            "px, tolerance=" + Number(diagnostics.tolerance).toFixed(4) +
            "px, verificationPassed=false, scaleAnchor=" + diagnostics.scaleAnchor +
            ", postScaleContainmentOrNormalization=none.";
    }
    function applyEccwLogoAlphaPlacement(document, layer, logoDirection, sourceGeometry, placementDiagnostics) {
        app.activeDocument = document;
        document.activeLayer = layer;
        var initialPlacementTransform = smartObjectPlacementTransform(layer);
        var initialBounds = activeLayerTransparencyBounds(document, layer, "placed showLogo before scaling");
        var initialWidth = Number(initialBounds.right) - Number(initialBounds.left);
        var requestedWidth = Number(logoDirection.visibleWidth);
        var nominalScaleFactor = requestedWidth / Number(sourceGeometry.sourceAlphaVisibleWidth);
        var initialPlacedScaleFactor = initialWidth / Number(sourceGeometry.sourceAlphaVisibleWidth);
        var initialRelativeScaleFactor = nominalScaleFactor / initialPlacedScaleFactor;
        layer.resize(initialRelativeScaleFactor * 100, initialRelativeScaleFactor * 100, AnchorPosition.MIDDLECENTER);
        var nominalBounds = activeLayerTransparencyBounds(document, layer, "placed showLogo after nominal alpha-derived scaling");
        var measuredWidthAfterNominalScale = Number(nominalBounds.right) - Number(nominalBounds.left);
        var correctionFactors = [], finalBounds = nominalBounds, finalMeasuredWidth = measuredWidthAfterNominalScale;
        while (
            Math.abs(finalMeasuredWidth - requestedWidth) > ECCW_LOGO_WIDTH_VERIFICATION_TOLERANCE &&
            correctionFactors.length < ECCW_LOGO_MAX_CORRECTION_ITERATIONS
        ) {
            var correctionFactor = requestedWidth / finalMeasuredWidth;
            correctionFactors.push(correctionFactor);
            layer.resize(correctionFactor * 100, correctionFactor * 100, AnchorPosition.MIDDLECENTER);
            finalBounds = activeLayerTransparencyBounds(
                document,
                layer,
                "placed showLogo after correction " + correctionFactors.length
            );
            finalMeasuredWidth = Number(finalBounds.right) - Number(finalBounds.left);
        }
        var expectedCenterX = 960 + Number(logoDirection.xOffset);
        var expectedCenterY = 92 + Number(logoDirection.yOffset);
        layer.translate(
            UnitValue(expectedCenterX - ((finalBounds.left + finalBounds.right) / 2), "px"),
            UnitValue(expectedCenterY - ((finalBounds.top + finalBounds.bottom) / 2), "px")
        );
        finalBounds = activeLayerTransparencyBounds(document, layer, "placed showLogo after offsets");
        finalMeasuredWidth = Number(finalBounds.right) - Number(finalBounds.left);
        var diagnostics = calculateEccwLogoScaleDiagnostics(
            sourceGeometry.sourceFullWidth,
            sourceGeometry.sourceAlphaVisibleWidth,
            requestedWidth,
            initialWidth,
            initialPlacementTransform,
            measuredWidthAfterNominalScale,
            correctionFactors,
            finalMeasuredWidth,
            ECCW_LOGO_WIDTH_VERIFICATION_TOLERANCE
        );
        if (placementDiagnostics) placementDiagnostics.showLogo = cloneJsonValue(diagnostics);
        if (!diagnostics.verificationPassed) throw new Error(formatEccwLogoWidthVerificationFailure(diagnostics));
        var finalGeometry = rect(finalBounds);
        if (Math.abs(finalGeometry.centerX - expectedCenterX) > diagnostics.tolerance || Math.abs(finalGeometry.centerY - expectedCenterY) > diagnostics.tolerance) {
            throw new Error("showLogo alpha-visible center verification failed after applying xOffset/yOffset.");
        }
        return finalBounds;
    }
    function applyEccwVisibleContentPlacement(document, layer, role, artDirection, logoSourceGeometry, placementDiagnostics) {
        app.activeDocument = document;
        document.activeLayer = layer;
        if (role === "showLogo") {
            if (!logoSourceGeometry) throw new Error("showLogo alpha-visible placement requires measured source geometry.");
            return applyEccwLogoAlphaPlacement(document, layer, artDirection.topPlate.logo, logoSourceGeometry, placementDiagnostics);
        }
        var initialBounds = safeTransformBounds(layer);
        if (!initialBounds) throw new Error("Could not read alpha-visible bounds for " + role + ".");
        var initial = rect(initialBounds);
        if (initial.width <= 0 || initial.height <= 0) throw new Error(role + " has empty alpha-visible bounds.");
        var scaleRatio, expectedCenterX, expectedCenterY = null, expectedTop = null;
        if (role === "competitorLeft" || role === "competitorRight") {
            var competitorDirection = artDirection[role];
            scaleRatio = (605 * Number(competitorDirection.scale)) / initial.height;
            expectedCenterX = (role === "competitorLeft" ? 480 : 1440) + Number(competitorDirection.xOffset);
            expectedTop = Number(competitorDirection.headTargetY) + Number(competitorDirection.yOffset);
        } else {
            throw new Error("Unsupported ECCW alpha-aware placement role: " + role);
        }
        layer.resize(scaleRatio * 100, scaleRatio * 100, AnchorPosition.MIDDLECENTER);
        var resizedBounds = safeTransformBounds(layer);
        if (!resizedBounds) throw new Error("Could not read alpha-visible bounds after sizing " + role + ".");
        var desiredY = expectedCenterY === null ? expectedTop + ((resizedBounds.bottom - resizedBounds.top) / 2) : expectedCenterY;
        layer.translate(
            UnitValue(expectedCenterX - ((resizedBounds.left + resizedBounds.right) / 2), "px"),
            UnitValue(desiredY - ((resizedBounds.top + resizedBounds.bottom) / 2), "px")
        );
        var placedBounds = safeTransformBounds(layer);
        if (!placedBounds) throw new Error("Could not read final alpha-visible bounds for " + role + ".");
        var placed = rect(placedBounds);
        if (Math.abs(placed.centerX - expectedCenterX) > 1) throw new Error(role + " alpha-visible content is not horizontally centered.");
        if (expectedTop !== null && Math.abs(placed.top - expectedTop) > 1) throw new Error(role + " alpha-visible content does not begin near y=" + expectedTop + ".");
        if (expectedCenterY !== null && Math.abs(placed.centerY - expectedCenterY) > 1) throw new Error(role + " alpha-visible content is not vertically centered.");
        if ((role === "competitorLeft" || role === "competitorRight") && Math.abs(placed.height - (605 * Number(artDirection[role].scale))) > 1) {
            throw new Error(role + " alpha-visible height does not match the resolved art-direction scale.");
        }
        return placedBounds;
    }
    function deterministicEccwPlacement(role, requestedPlacement, warnings, artDirection) {
        var geometry = null;
        if (role === "competitorLeft" || role === "competitorRight") {
            var direction = artDirection[role];
            geometry = {
                x: (role === "competitorLeft" ? 480 : 1440) + Number(direction.xOffset),
                y: (Number(direction.headTargetY) + Number(direction.yOffset) + Number(direction.cutoffY)) / 2,
                maxWidth: 740,
                maxHeight: 605,
                scale: Number(direction.scale)
            };
        } else if (role === "showLogo") {
            geometry = {
                x: 960 + Number(artDirection.topPlate.logo.xOffset),
                y: 92 + Number(artDirection.topPlate.logo.yOffset),
                maxWidth: Number(artDirection.topPlate.logo.visibleWidth),
                maxHeight: 220,
                scale: 1
            };
        }
        if (!geometry) return requestedPlacement ? cloneJsonValue(requestedPlacement) : null;
        var placement = {
            coordinateSpace: "pixels",
            x: geometry.x,
            y: geometry.y,
            fitMode: "contain",
            scale: geometry.scale,
            maxWidth: geometry.maxWidth,
            maxHeight: geometry.maxHeight
        };
        if (role === "competitorLeft" || role === "competitorRight") placement.nonGenerativeMask = true;
        if (requestedPlacement) {
            if (requestedPlacement.clippingMask === true) {
                warnings.push(
                    "The ECCW panel preset replaced requested clipping for " + role +
                    " with its mandatory non-destructive cutoff user layer mask; no clipping base or backing rectangle was created."
                );
            }
            if (own(requestedPlacement, "dropShadow")) placement.dropShadow = requestedPlacement.dropShadow;
            if (own(requestedPlacement, "outerGlow")) placement.outerGlow = requestedPlacement.outerGlow;
        }
        return placement;
    }
    function applyDeterministicEccwPlacements(payload, warnings, artDirection) {
        if (payload.style.layoutPreset !== ECCW_PANEL_LAYOUT_PRESET) return;
        var requested = payload.placements || {}, resolved = {};
        var roles = ["competitorLeft", "competitorRight", "showLogo"];
        for (var i = 0; i < roles.length; i++) {
            var role = roles[i];
            resolved[role] = deterministicEccwPlacement(role, own(requested, role) ? requested[role] : null, warnings, artDirection);
        }
        payload.placements = resolved;
    }
    function setEccwCompetitorShadow(document, layer, direction) {
        app.activeDocument = document;
        document.activeLayer = layer;
        var effects = readPreservableLayerEffects(), shadowKey = stringIDToTypeID("dropShadow");
        if (Number(direction.shadowOpacity) <= 0) {
            if (effects.hasKey(shadowKey)) effects.erase(shadowKey);
        } else {
            var shadow = new ActionDescriptor(), black = new ActionDescriptor();
            shadow.putBoolean(charIDToTypeID("enab"), true);
            shadow.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Mltp"));
            shadow.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), Number(direction.shadowOpacity));
            shadow.putUnitDouble(charIDToTypeID("Dstn"), charIDToTypeID("#Pxl"), Number(direction.shadowDistance));
            shadow.putUnitDouble(charIDToTypeID("blur"), charIDToTypeID("#Pxl"), 18);
            black.putDouble(charIDToTypeID("Rd  "), 0); black.putDouble(charIDToTypeID("Grn "), 0); black.putDouble(charIDToTypeID("Bl  "), 0);
            shadow.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), black);
            effects.putObject(shadowKey, shadowKey, shadow);
        }
        var scaleKey = stringIDToTypeID("scale");
        if (!effects.hasKey(scaleKey)) effects.putUnitDouble(scaleKey, charIDToTypeID("#Prc"), 100);
        var setDescriptor = new ActionDescriptor(), setReference = new ActionReference();
        setReference.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("layerEffects"));
        setReference.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        setDescriptor.putReference(charIDToTypeID("null"), setReference);
        setDescriptor.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), effects);
        executeAction(charIDToTypeID("setd"), setDescriptor, DialogModes.NO);
    }
    function createEccwBrightnessContrastAdjustment(document, group, targetLayer, role, direction) {
        if (!own(direction, "brightness") && !own(direction, "contrast")) return null;
        app.activeDocument = document;
        document.activeLayer = targetLayer;
        var makeDescriptor = new ActionDescriptor(), makeReference = new ActionReference();
        makeReference.putClass(charIDToTypeID("AdjL"));
        makeDescriptor.putReference(charIDToTypeID("null"), makeReference);
        var usingDescriptor = new ActionDescriptor(), adjustmentDescriptor = new ActionDescriptor();
        adjustmentDescriptor.putInteger(charIDToTypeID("Brgh"), own(direction, "brightness") ? Number(direction.brightness) : 0);
        adjustmentDescriptor.putInteger(charIDToTypeID("Cntr"), own(direction, "contrast") ? Number(direction.contrast) : 0);
        adjustmentDescriptor.putBoolean(stringIDToTypeID("useLegacy"), false);
        usingDescriptor.putObject(charIDToTypeID("Type"), charIDToTypeID("BrgC"), adjustmentDescriptor);
        makeDescriptor.putObject(charIDToTypeID("Usng"), charIDToTypeID("AdjL"), usingDescriptor);
        executeAction(charIDToTypeID("Mk  "), makeDescriptor, DialogModes.NO);
        var adjustmentLayer = document.activeLayer;
        adjustmentLayer.name = MATCH_ASSET_LAYER_NAMES[role] + " - BRIGHTNESS CONTRAST";
        adjustmentLayer.move(targetLayer, ElementPlacement.PLACEBEFORE);
        adjustmentLayer.grouped = true;
        if (!adjustmentLayer.grouped) throw new Error("Photoshop did not clip the non-destructive brightness/contrast adjustment to " + role + ".");
        return adjustmentLayer;
    }
    function placeMatchAsset(document, folder, role, fileName, groups, placement, accentColor, layoutPreset, semanticReferences, warnings, artDirection, placementDiagnostics) {
        var file = childFile(folder, fileName);
        if (!file.exists) throw new Error("Missing required asset: " + fileName);
        inspectCompetitorTransparencyBeforePlacement(file, role, warnings || []);
        var logoSourceGeometry = layoutPreset === ECCW_PANEL_LAYOUT_PRESET && role === "showLogo" ?
            inspectEccwLogoSourceAlphaGeometry(file) :
            null;
        var group = groupForAssetRole(groups, role), layer = placeFileAsSmartObject(document, file, group, MATCH_ASSET_LAYER_NAMES[role]);
        var isEccwCoreAsset = layoutPreset === ECCW_PANEL_LAYOUT_PRESET && valueInList(role, ["competitorLeft", "competitorRight", "showLogo"]);
        var targetBounds = isEccwCoreAsset ?
            applyEccwVisibleContentPlacement(document, layer, role, artDirection, logoSourceGeometry, placementDiagnostics) :
            applyLayerPlacement(document, layer, role, placement || null, "contain", layoutPreset);
        if (isEccwCoreAsset && (role === "competitorLeft" || role === "competitorRight")) {
            applyMandatoryEccwCutoffMask(document, layer, role, targetBounds, Number(artDirection[role].cutoffY));
            setEccwCompetitorShadow(document, layer, artDirection[role]);
            createEccwBrightnessContrastAdjustment(document, group, layer, role, artDirection[role]);
        }
        if (!isEccwCoreAsset && placement && own(placement, "clippingMask")) {
            try {
                var createdBase = applyClippingPreference(document, layer, group, role, targetBounds, placement.clippingMask, null);
                if (createdBase && semanticReferences) semanticReferences[role + "ClippingBase"] = createdBase;
            } catch (error) { throw new Error("Could not apply clipping mask for " + role + ": " + error.message); }
        }
        if (!isEccwCoreAsset && placement && own(placement, "nonGenerativeMask")) applyNonGenerativeMaskPreference(document, layer, targetBounds, placement.nonGenerativeMask, role, false, false);
        if (!(isEccwCoreAsset && (role === "competitorLeft" || role === "competitorRight"))) {
            setLayerEffectsForPlacement(document, layer, placement || null, accentColor);
        }
        return layer;
    }
    function installedFonts() {
        var result = [], seen = {};
        try {
            for (var i = 0; i < app.fonts.length; i++) {
                var postScriptName = "", displayName = "", family = "", style = "";
                try { postScriptName = String(app.fonts[i].postScriptName); } catch (_postScriptNameError) {}
                try { displayName = String(app.fonts[i].name); } catch (_fontDisplayNameError) {}
                try { family = String(app.fonts[i].family); } catch (_fontFamilyError) {}
                try { style = String(app.fonts[i].style); } catch (_fontStyleError) {}
                if (postScriptName && !seen[postScriptName.toLowerCase()]) {
                    seen[postScriptName.toLowerCase()] = true;
                    result.push({
                        postScriptName: postScriptName,
                        displayName: displayName,
                        family: family,
                        style: style
                    });
                }
            }
        } catch (_fontEnumerationError) {}
        return result;
    }
    function resolveMatchFont(requested, role, fonts, warnings) {
        var i, wanted = requested ? String(requested).toLowerCase() : "";
        if (wanted) {
            for (i = 0; i < fonts.length; i++) {
                if (fonts[i].postScriptName.toLowerCase() === wanted || fonts[i].displayName.toLowerCase() === wanted) return fonts[i].postScriptName;
            }
            warnings.push('Requested font "' + requested + '" for ' + role + " is unavailable; a local fallback was used.");
        }
        var candidates = ["Arial-BoldMT", "ArialMT", "Helvetica-Bold", "Helvetica", "MyriadPro-Bold", "MyriadPro-Regular"];
        for (var c = 0; c < candidates.length; c++) for (i = 0; i < fonts.length; i++) if (fonts[i].postScriptName.toLowerCase() === candidates[c].toLowerCase()) return fonts[i].postScriptName;
        return fonts.length ? fonts[0].postScriptName : null;
    }
    function resolveApprovedEccwFont(fonts) {
        var best = null, bestScore = -1;
        for (var i = 0; i < fonts.length; i++) {
            var font = fonts[i];
            var identity = (
                String(font.family || "") + " " +
                String(font.style || "") + " " +
                String(font.displayName || "") + " " +
                String(font.postScriptName || "")
            ).toLowerCase();
            var score = -1;
            var isBold = identity.indexOf("bold") !== -1;
            var isCondensed = identity.indexOf("condensed") !== -1 || identity.indexOf("narrow") !== -1;
            if (identity.indexOf("bahnschrift") !== -1 && isBold && isCondensed) {
                var isSemiBold = identity.indexOf("semibold") !== -1 || identity.indexOf("semi bold") !== -1;
                score = isSemiBold ? 550 : (identity.indexOf("semicondensed") !== -1 || identity.indexOf("semi condensed") !== -1 ? 475 : 500);
            }
            else if (identity.indexOf("arial narrow") !== -1 && isBold) score = 300;
            else if (identity.indexOf("impact") !== -1) score = 200;
            if (score > bestScore) {
                best = font;
                bestScore = score;
            }
        }
        if (!best) {
            throw new Error(
                "The ECCW panel preset requires an installed approved display font: " +
                "Bahnschrift SemiBold Condensed or condensed bold, Arial Narrow Bold, or Impact."
            );
        }
        return best;
    }
    function recordApprovedEccwFont(style, resolvedFont, warnings) {
        style.fonts = {
            mainTitle: resolvedFont.postScriptName,
            competitorNames: resolvedFont.postScriptName,
            date: resolvedFont.postScriptName
        };
        warnings.push(
            'ECCW design font selected: family="' + String(resolvedFont.family || "") +
            '", style="' + String(resolvedFont.style || "") +
            '", PostScript="' + String(resolvedFont.postScriptName) + '".'
        );
    }
    function fontRoleForText(role) {
        if (role === "matchTitle") return "mainTitle";
        if (role === "championship") return "championshipLabel";
        if (role === "competitorLeftName" || role === "competitorRightName" || role === "competitorCenterName") return "competitorNames";
        return role;
    }
    function textPositionAndSize(role, width, height, layoutPreset, artDirection) {
        if (layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            artDirection = artDirection || resolvedEccwArtDirection({});
            if (role === "competitorLeftName" || role === "competitorRightName") {
                var plateWidth = 765, plateHeight = 140, nameplates = artDirection.nameplates;
                var targetWidth = Math.min(
                    plateWidth * Number(nameplates.targetWidthOccupancy),
                    plateWidth - (2 * Number(nameplates.minimumHorizontalPadding))
                );
                return {
                    x: role === "competitorLeftName" ? 515 : 1405,
                    y: 925,
                    size: Number(nameplates.maximumFontSize),
                    minimumFontSize: Number(nameplates.minimumFontSize),
                    tracking: Number(nameplates.tracking),
                    maxWidth: targetWidth,
                    maxHeight: plateHeight * Number(nameplates.targetHeightOccupancy),
                    center: true
                };
            }
            if (role === "matchTitle") return {
                x: 960 + Number(artDirection.vs.xOffset),
                y: 594 + Number(artDirection.vs.yOffset),
                size: Number(artDirection.vs.fontSize),
                minimumFontSize: 40,
                maxWidth: 110,
                maxHeight: 85,
                center: true
            };
            if (role === "date") return {
                x: 960 + Number(artDirection.topPlate.date.xOffset),
                y: 208 + Number(artDirection.topPlate.date.yOffset),
                size: Number(artDirection.topPlate.date.fontSize),
                minimumFontSize: 18,
                maxWidth: 440,
                maxHeight: 72,
                center: true
            };
            if (role === "stipulation") return {
                x: 960 + Number(artDirection.topPlate.stipulation.xOffset),
                y: 250 + Number(artDirection.topPlate.stipulation.yOffset),
                size: Number(artDirection.topPlate.stipulation.fontSize),
                minimumFontSize: 18,
                maxWidth: 440,
                maxHeight: 36,
                center: true
            };
        }
        if (layoutPreset === "single-competitor-title-side" && (role === "championship" || role === "matchTitle" || role === "stipulation")) {
            if (role === "championship") return { x: width * 0.72, y: height * 0.36, size: height * 0.028, center: true };
            if (role === "matchTitle") return { x: width * 0.72, y: height * 0.51, size: height * 0.065, center: true };
            return { x: width * 0.72, y: height * 0.67, size: height * 0.03, center: true };
        }
        if (layoutPreset === "two-competitor-title-lower" && (role === "championship" || role === "matchTitle" || role === "stipulation")) {
            if (role === "championship") return { x: width * 0.5, y: height * 0.59, size: height * 0.028, center: true };
            if (role === "matchTitle") return { x: width * 0.5, y: height * 0.69, size: height * 0.064, center: true };
            return { x: width * 0.5, y: height * 0.77, size: height * 0.026, center: true };
        }
        if (layoutPreset === "three-competitor-title-center" && (role === "championship" || role === "matchTitle" || role === "stipulation")) {
            if (role === "championship") return { x: width * 0.5, y: height * 0.43, size: height * 0.026, center: true };
            if (role === "matchTitle") return { x: width * 0.5, y: height * 0.55, size: height * 0.062, center: true };
            return { x: width * 0.5, y: height * 0.68, size: height * 0.026, center: true };
        }
        if (role === "championship") return { x: width * 0.5, y: height * 0.45, size: height * 0.031, center: true };
        if (role === "matchTitle") return { x: width * 0.5, y: height * 0.59, size: height * 0.078, center: true };
        if (role === "stipulation") return { x: width * 0.5, y: height * 0.72, size: height * 0.032, center: true };
        if (role === "competitorLeftName") return { x: width * 0.24, y: height * 0.75, size: height * 0.047, center: true };
        if (role === "competitorRightName") return { x: width * 0.76, y: height * 0.75, size: height * 0.047, center: true };
        if (role === "competitorCenterName") return { x: width * 0.5, y: height * 0.75, size: height * 0.047, center: true };
        if (role === "date") return { x: width * 0.5, y: height * 0.84, size: height * 0.026, center: true };
        if (role === "time") return { x: width * 0.5, y: height * 0.89, size: height * 0.023, center: true };
        return { x: width * 0.5, y: height * 0.95, size: height * 0.019, center: true };
    }
    function constrainLiveTextToGeometry(document, layer, role, geometry) {
        if (!own(geometry, "maxWidth") || !own(geometry, "maxHeight")) return;
        var bounds = null, measured = null;
        for (var attempt = 0; attempt < 6; attempt++) {
            bounds = safeTransformBounds(layer);
            if (!bounds) throw new Error("Could not read live text bounds for " + role + ".");
            measured = rect(bounds);
            if (measured.width <= 0 || measured.height <= 0) throw new Error("Live text has empty bounds for " + role + ".");
            var ratio = Math.min(1, Number(geometry.maxWidth) / measured.width, Number(geometry.maxHeight) / measured.height);
            if (ratio >= 0.999) break;
            var currentPointSize;
            try { currentPointSize = Number(layer.textItem.size.as("pt")); }
            catch (_eccwTextPointSizeError) { currentPointSize = Number(layer.textItem.size); }
            if (!isFinite(currentPointSize) || currentPointSize <= 0) throw new Error("Could not reduce the live font size for " + role + ".");
            var minimumPointSize = own(geometry, "minimumFontSize") ? Number(geometry.minimumFontSize) : 8;
            layer.textItem.size = UnitValue(Math.max(minimumPointSize, currentPointSize * ratio * 0.99), "pt");
        }
        bounds = safeTransformBounds(layer);
        if (!bounds) throw new Error("Could not read constrained live text bounds for " + role + ".");
        layer.translate(
            UnitValue(Number(geometry.x) - ((bounds.left + bounds.right) / 2), "px"),
            UnitValue(Number(geometry.y) - ((bounds.top + bounds.bottom) / 2), "px")
        );
        bounds = safeTransformBounds(layer);
        if (!bounds || bounds.right - bounds.left > Number(geometry.maxWidth) + 1 || bounds.bottom - bounds.top > Number(geometry.maxHeight) + 1) {
            throw new Error("Live text could not be constrained to the ECCW panel for " + role + ".");
        }
        app.activeDocument = document;
        document.activeLayer = layer;
    }
    function setEccwTextEffects(document, layer, role, artDirection) {
        app.activeDocument = document;
        document.activeLayer = layer;
        var effects = readPreservableLayerEffects();
        var topTextConfig = role === "date" || role === "stipulation" ? artDirection.topPlate[role] : null;
        var shadowConfig = topTextConfig ? topTextConfig.shadow : {
            enabled: true,
            opacity: 35,
            distance: 4,
            blur: 6
        };
        var shadowKey = stringIDToTypeID("dropShadow");
        if (shadowConfig.enabled) {
            var shadow = new ActionDescriptor(), black = new ActionDescriptor();
            shadow.putBoolean(charIDToTypeID("enab"), true);
            shadow.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Mltp"));
            shadow.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), Number(shadowConfig.opacity));
            shadow.putUnitDouble(charIDToTypeID("Dstn"), charIDToTypeID("#Pxl"), Number(shadowConfig.distance));
            shadow.putUnitDouble(charIDToTypeID("blur"), charIDToTypeID("#Pxl"), Number(shadowConfig.blur));
            black.putDouble(charIDToTypeID("Rd  "), 0);
            black.putDouble(charIDToTypeID("Grn "), 0);
            black.putDouble(charIDToTypeID("Bl  "), 0);
            shadow.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), black);
            effects.putObject(shadowKey, shadowKey, shadow);
        } else if (effects.hasKey(shadowKey)) {
            effects.erase(shadowKey);
        }
        var fixedStrokeRole = role === "competitorLeftName" || role === "competitorRightName" || role === "matchTitle";
        var configuredStroke = topTextConfig ? topTextConfig.stroke : null;
        var strokeEnabled = fixedStrokeRole || (configuredStroke && configuredStroke.enabled);
        var strokeKey = charIDToTypeID("FrFX");
        if (strokeEnabled) {
            var stroke = new ActionDescriptor(), strokeColor = new ActionDescriptor();
            stroke.putBoolean(charIDToTypeID("enab"), true);
            stroke.putEnumerated(charIDToTypeID("Styl"), charIDToTypeID("FStl"), charIDToTypeID("OutF"));
            stroke.putEnumerated(charIDToTypeID("PntT"), charIDToTypeID("FrFl"), charIDToTypeID("SClr"));
            stroke.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));
            var strokeOpacity = configuredStroke ? Number(configuredStroke.opacity) : (role === "matchTitle" ? 82 : 72);
            var strokeSize = configuredStroke ? Number(configuredStroke.size) : (role === "matchTitle" ? 2 : 3);
            stroke.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), strokeOpacity);
            stroke.putUnitDouble(charIDToTypeID("Sz  "), charIDToTypeID("#Pxl"), strokeSize);
            if (configuredStroke) {
                strokeColor.putDouble(charIDToTypeID("Rd  "), Number(configuredStroke.color.red));
                strokeColor.putDouble(charIDToTypeID("Grn "), Number(configuredStroke.color.green));
                strokeColor.putDouble(charIDToTypeID("Bl  "), Number(configuredStroke.color.blue));
            } else if (role === "matchTitle") {
                strokeColor.putDouble(charIDToTypeID("Rd  "), 238);
                strokeColor.putDouble(charIDToTypeID("Grn "), 238);
                strokeColor.putDouble(charIDToTypeID("Bl  "), 238);
            } else {
                strokeColor.putDouble(charIDToTypeID("Rd  "), 198);
                strokeColor.putDouble(charIDToTypeID("Grn "), 24);
                strokeColor.putDouble(charIDToTypeID("Bl  "), 32);
            }
            stroke.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), strokeColor);
            effects.putObject(strokeKey, strokeKey, stroke);
        } else if (effects.hasKey(strokeKey)) effects.erase(strokeKey);
        var effectsScale = stringIDToTypeID("scale");
        if (!effects.hasKey(effectsScale)) effects.putUnitDouble(effectsScale, charIDToTypeID("#Prc"), 100);
        var setDescriptor = new ActionDescriptor(), setReference = new ActionReference();
        setReference.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("layerEffects"));
        setReference.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        setDescriptor.putReference(charIDToTypeID("null"), setReference);
        setDescriptor.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), effects);
        executeAction(charIDToTypeID("setd"), setDescriptor, DialogModes.NO);
    }
    function createEditableMatchText(document, group, role, contents, style, fontList, warnings, approvedEccwFont, artDirection) {
        app.activeDocument = document;
        var layer = document.artLayers.add();
        layer.kind = LayerKind.TEXT;
        layer.name = MATCH_TEXT_LAYER_NAMES[role];
        var textItem = layer.textItem, geometry = textPositionAndSize(role, toPixels(document.width), toPixels(document.height), style.layoutPreset, artDirection);
        textItem.contents = normalizeTextForPhotoshop(contents);
        textItem.position = [UnitValue(geometry.x, "px"), UnitValue(geometry.y, "px")];
        textItem.size = UnitValue(Math.max(8, geometry.size * 72 / Number(document.resolution)), "pt");
        if (own(geometry, "tracking")) textItem.tracking = Number(geometry.tracking);
        if (geometry.center) textItem.justification = Justification.CENTER;
        var fontRole = fontRoleForText(role), requested = style.fonts && own(style.fonts, fontRole) ? style.fonts[fontRole] : null;
        var font = approvedEccwFont ? approvedEccwFont.postScriptName : resolveMatchFont(requested, fontRole, fontList, warnings);
        if (font) {
            try { textItem.font = font; }
            catch (fontError) {
                if (approvedEccwFont) throw new Error("Photoshop could not apply the approved ECCW font to " + role + ": " + fontError.message);
                warnings.push("Photoshop could not apply font " + font + " to " + role + ": " + fontError.message);
            }
        } else warnings.push("No installed Photoshop font could be selected for " + role + ".");
        var color = new SolidColor(), rgb = role === "championship" ? style.metallicColor : style.accentColor;
        if (style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && (role === "competitorLeftName" || role === "competitorRightName")) {
            rgb = { red: 255, green: 255, blue: 255 };
        } else if (style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && role === "matchTitle") {
            rgb = artDirection.vs.fill;
        } else if (style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && (role === "date" || role === "stipulation")) {
            rgb = artDirection.topPlate[role].fill;
        }
        color.rgb.red = rgb.red; color.rgb.green = rgb.green; color.rgb.blue = rgb.blue;
        textItem.color = color;
        layer.move(group, ElementPlacement.INSIDE);
        constrainLiveTextToGeometry(document, layer, role, geometry);
        if (style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) setEccwTextEffects(document, layer, role, artDirection);
        document.activeLayer = layer;
        return layer;
    }
    function applyApprovedEccwTextStyles(document, references, approvedFont, artDirection) {
        var roles = ["competitorLeftName", "competitorRightName", "matchTitle", "date", "stipulation"];
        for (var i = 0; i < roles.length; i++) {
            var role = roles[i], layer = references[role];
            if (!layer) continue;
            if (!isTextLayer(layer)) throw new Error("ECCW semantic role is no longer editable live text: " + role);
            try { layer.textItem.font = approvedFont.postScriptName; }
            catch (fontError) { throw new Error("Photoshop could not apply the approved ECCW font to " + role + ": " + fontError.message); }
            var color = new SolidColor();
            if (role === "matchTitle") {
                var configuredVsFill = artDirection.vs.fill;
                color.rgb.red = configuredVsFill.red; color.rgb.green = configuredVsFill.green; color.rgb.blue = configuredVsFill.blue;
            } else if (role === "date" || role === "stipulation") {
                var configuredFill = artDirection.topPlate[role].fill;
                color.rgb.red = configuredFill.red; color.rgb.green = configuredFill.green; color.rgb.blue = configuredFill.blue;
            } else {
                color.rgb.red = 255; color.rgb.green = 255; color.rgb.blue = 255;
            }
            layer.textItem.color = color;
            var geometry = textPositionAndSize(role, ECCW_PANEL_CANVAS_WIDTH, ECCW_PANEL_CANVAS_HEIGHT, ECCW_PANEL_LAYOUT_PRESET, artDirection);
            layer.textItem.size = UnitValue(Math.max(8, geometry.size * 72 / Number(document.resolution)), "pt");
            if (own(geometry, "tracking")) layer.textItem.tracking = Number(geometry.tracking);
            constrainLiveTextToGeometry(
                document,
                layer,
                role,
                geometry
            );
            setEccwTextEffects(document, layer, role, artDirection);
        }
    }
    function layerAndParentsVisible(layer) {
        var current = layer;
        try {
            while (current && current.typename !== "Document") {
                if (!Boolean(current.visible)) return false;
                current = current.parent;
            }
        } catch (_eccwVisibilityError) {
            return false;
        }
        return true;
    }
    function topLevelLayerIndex(document, layer) {
        var wantedId = safeLayerId(layer);
        for (var i = 0; i < document.layers.length; i++) {
            if (safeLayerId(document.layers[i]) === wantedId) return i;
        }
        return -1;
    }
    function visibleCanvasIntersection(document, layer) {
        var bounds = safeTransformBounds(layer);
        if (!bounds) return null;
        var width = toPixels(document.width), height = toPixels(document.height);
        var intersectionWidth = Math.max(0, Math.min(bounds.right, width) - Math.max(bounds.left, 0));
        var intersectionHeight = Math.max(0, Math.min(bounds.bottom, height) - Math.max(bounds.top, 0));
        return {
            bounds: bounds,
            width: intersectionWidth,
            height: intersectionHeight,
            area: intersectionWidth * intersectionHeight
        };
    }
    function assertLayerInsideCanvas(document, layer, role) {
        var intersection = visibleCanvasIntersection(document, layer);
        if (!intersection || intersection.area <= 0) throw new Error(role + " has zero visible intersection with the canvas.");
        var width = toPixels(document.width), height = toPixels(document.height), bounds = intersection.bounds, tolerance = 1;
        if (bounds.left < -tolerance || bounds.top < -tolerance || bounds.right > width + tolerance || bounds.bottom > height + tolerance) {
            throw new Error(role + " extends outside the 1920x1080 canvas.");
        }
        return rect(bounds);
    }
    function assertEccwCompetitorVisible(document, layer, groups, role) {
        if (!layer || !isSmartObject(layer)) throw new Error(role + " is not a placed Smart Object.");
        if (!layerAndParentsVisible(layer)) throw new Error(role + " is hidden.");
        var bounds = assertLayerInsideCanvas(document, layer, role);
        if (bounds.width <= 0 || bounds.height <= 0) throw new Error(role + " has empty placed bounds.");
        var competitorIndex = topLevelLayerIndex(document, groups.competitorRenders);
        var templateIndex = topLevelLayerIndex(document, groups.templateBackground);
        if (competitorIndex < 0 || templateIndex < 0 || competitorIndex >= templateIndex) {
            throw new Error(role + " is not above the template background.");
        }
        var aboveCompetitors = [groups.matchTitleGroup, groups.eventInformation, groups.showLogoGroup];
        for (var i = 0; i < aboveCompetitors.length; i++) {
            var groupIndex = topLevelLayerIndex(document, aboveCompetitors[i]);
            if (groupIndex < 0 || groupIndex >= competitorIndex) throw new Error(role + " is not below the live text and finishing groups.");
        }
        return bounds;
    }
    function assertEccwCompetitorMaskAndOccupancy(document, layer, role, direction) {
        var cutoffY = Number(direction.cutoffY);
        if (!layerHasUserMask(layer)) throw new Error(role + " is missing its mandatory cutoff user layer mask.");
        var revealBounds;
        try {
            revealBounds = activeUserMaskSelectionBounds(document, layer);
        } catch (error) {
            throw new Error(role + " mandatory mask could not be verified: " + error.message);
        }
        if (
            Math.abs(revealBounds.left) > 1 ||
            Math.abs(revealBounds.top) > 1 ||
            Math.abs(revealBounds.right - ECCW_PANEL_CANVAS_WIDTH) > 1 ||
            Math.abs(revealBounds.bottom - cutoffY) > 1
        ) {
            throw new Error(role + " mandatory mask does not conceal all pixels below y=" + cutoffY + ".");
        }
        var unmaskedBounds = measureBoundsBehindEccwMask(document, layer, role, cutoffY);
        var unmasked = rect(unmaskedBounds);
        var visibleTop = Math.max(0, unmasked.top);
        var visibleBottom = Math.min(cutoffY, unmasked.bottom);
        var visibleHeight = Math.max(0, visibleBottom - visibleTop);
        var visibleWidth = Math.max(0, Math.min(ECCW_PANEL_CANVAS_WIDTH, unmasked.right) - Math.max(0, unmasked.left));
        var visibleArea = visibleWidth * visibleHeight;
        var expectedCenterX = (role === "competitorLeft" ? 480 : 1440) + Number(direction.xOffset);
        var expectedTop = Number(direction.headTargetY) + Number(direction.yOffset);
        var expectedHeight = 605 * Number(direction.scale);
        if (Math.abs(unmasked.centerX - expectedCenterX) > 2) throw new Error(role + " alpha-visible content does not match its resolved horizontal offset.");
        if (Math.abs(visibleTop - expectedTop) > 2) throw new Error(role + " visible top does not match its resolved head target and y offset.");
        if (Math.abs(unmasked.height - expectedHeight) > 2) throw new Error(role + " does not match its resolved scale.");
        if (visibleArea <= 0) throw new Error(role + " has no visible alpha-aware occupancy above its cutoff.");
        return {
            bounds: unmasked,
            visibleTop: visibleTop,
            visibleBottom: visibleBottom,
            visibleWidth: visibleWidth,
            visibleHeight: visibleHeight,
            visibleArea: visibleArea
        };
    }
    function textColorChannels(layer, role) {
        try {
            return {
                red: Number(layer.textItem.color.rgb.red),
                green: Number(layer.textItem.color.rgb.green),
                blue: Number(layer.textItem.color.rgb.blue)
            };
        } catch (error) {
            throw new Error("Could not verify live text color for " + role + ": " + error.message);
        }
    }
    function textPointSize(layer, role) {
        try { return Number(layer.textItem.size.as("pt")); }
        catch (_eccwPointSizeAsError) {
            try { return Number(layer.textItem.size); }
            catch (error) { throw new Error("Could not verify live point size for " + role + ": " + error.message); }
        }
    }
    function assertLayerCenter(layer, role, expectedX, expectedY, tolerance) {
        var bounds = safeTransformBounds(layer);
        if (!bounds) throw new Error("Could not read preview bounds for " + role + ".");
        var geometry = rect(bounds);
        if (Math.abs(geometry.centerX - expectedX) > tolerance || Math.abs(geometry.centerY - expectedY) > tolerance) {
            throw new Error(role + " is not centered in its deterministic ECCW panel.");
        }
        return geometry;
    }
    function assertAlphaVisibleLayerCenter(document, layer, role, expectedX, expectedY, tolerance) {
        var bounds = activeLayerTransparencyBounds(document, layer, role + " preview");
        var geometry = rect(bounds);
        if (Math.abs(geometry.centerX - expectedX) > tolerance || Math.abs(geometry.centerY - expectedY) > tolerance) {
            throw new Error(role + " alpha-visible pixels are not centered in the deterministic ECCW panel.");
        }
        return geometry;
    }
    function validateEccwPreviewLayout(document, semantic, layoutPreset, assets, text, groups, approvedFont, artDirection, runtimeDiagnostics) {
        if (layoutPreset !== ECCW_PANEL_LAYOUT_PRESET) return;
        if (toPixels(document.width) !== ECCW_PANEL_CANVAS_WIDTH || toPixels(document.height) !== ECCW_PANEL_CANVAS_HEIGHT) {
            throw new Error("ECCW preview validation requires an exact 1920x1080 canvas.");
        }
        if (topLevelLayerIndex(document, groups.templateBackground) !== document.layers.length - 1) {
            throw new Error("The template background group is not at the bottom of the ECCW layer stack.");
        }
        assertEccwCompetitorVisible(document, semantic.competitorLeft, groups, "competitorLeft");
        assertEccwCompetitorVisible(document, semantic.competitorRight, groups, "competitorRight");
        assertEccwCompetitorMaskAndOccupancy(document, semantic.competitorLeft, "competitorLeft", artDirection.competitorLeft);
        assertEccwCompetitorMaskAndOccupancy(document, semantic.competitorRight, "competitorRight", artDirection.competitorRight);
        var competitorGroupIndex = topLevelLayerIndex(document, groups.competitorRenders);
        var logoGroupIndex = topLevelLayerIndex(document, groups.showLogoGroup);
        var matchTextGroupIndex = topLevelLayerIndex(document, groups.matchTitleGroup);
        var eventTextGroupIndex = topLevelLayerIndex(document, groups.eventInformation);
        if (
            logoGroupIndex < 0 || competitorGroupIndex < 0 ||
            logoGroupIndex >= competitorGroupIndex ||
            logoGroupIndex <= matchTextGroupIndex ||
            logoGroupIndex <= eventTextGroupIndex
        ) {
            throw new Error("ECCW layer order must be template, masked competitors, logo, then live text.");
        }

        var generatedRectangleRoles = [
            "fullFrameAtmosphere", "lowerThirdPanel", "titleBacking", "showLogoPlate",
            "lowerLightStrip", "topBorder", "bottomBorder", "finishingGlow"
        ];
        var canvasArea = ECCW_PANEL_CANVAS_WIDTH * ECCW_PANEL_CANVAS_HEIGHT;
        for (var rectangleIndex = 0; rectangleIndex < generatedRectangleRoles.length; rectangleIndex++) {
            var rectangleRole = generatedRectangleRoles[rectangleIndex], rectangleLayer = semantic[rectangleRole];
            if (!rectangleLayer) continue;
            var rectangleBounds = safeTransformBounds(rectangleLayer);
            if (rectangleBounds) {
                var rectangleGeometry = rect(rectangleBounds);
                if (rectangleGeometry.width * rectangleGeometry.height > canvasArea * 0.25) {
                    throw new Error("Generated rectangle " + rectangleRole + " covers more than 25 percent of the ECCW canvas.");
                }
            }
            throw new Error("The ECCW panel template preset must not generate overlay rectangles: " + rectangleRole + ".");
        }

        var logoBounds = assertAlphaVisibleLayerCenter(
            document,
            semantic.showLogo,
            "showLogo",
            960 + Number(artDirection.topPlate.logo.xOffset),
            92 + Number(artDirection.topPlate.logo.yOffset),
            ECCW_LOGO_WIDTH_VERIFICATION_TOLERANCE
        );
        if (Math.abs(logoBounds.width - Number(artDirection.topPlate.logo.visibleWidth)) > ECCW_LOGO_WIDTH_VERIFICATION_TOLERANCE) {
            throw new Error("showLogo preview alpha-visible width does not match resolved art direction.");
        }
        var dateBounds = assertLayerCenter(
            semantic.date,
            "date",
            960 + Number(artDirection.topPlate.date.xOffset),
            208 + Number(artDirection.topPlate.date.yOffset),
            2
        );
        if (dateBounds.centerY >= ECCW_PANEL_CANVAS_HEIGHT * 0.25) throw new Error("date is not in the top 25 percent of the ECCW canvas.");
        var dateColor = textColorChannels(semantic.date, "date");
        var configuredDateColor = artDirection.topPlate.date.fill;
        if (
            Math.abs(dateColor.red - Number(configuredDateColor.red)) > 1 ||
            Math.abs(dateColor.green - Number(configuredDateColor.green)) > 1 ||
            Math.abs(dateColor.blue - Number(configuredDateColor.blue)) > 1
        ) throw new Error("JULY 23RD fill does not match resolved art direction.");
        var dateSize = textPointSize(semantic.date, "date");
        if (dateSize < 18 || dateSize > Number(artDirection.topPlate.date.fontSize) + 0.1) throw new Error("JULY 23RD font size is outside its resolved fit range.");
        var versusBounds = assertLayerCenter(
            semantic.matchTitle,
            "matchTitle",
            960 + Number(artDirection.vs.xOffset),
            594 + Number(artDirection.vs.yOffset),
            2
        );
        if (versusBounds.width > 111 || versusBounds.height > 86 || Math.abs(versusBounds.centerX - 960) > 120 || Math.abs(versusBounds.centerY - 540) > 120) {
            throw new Error("VS is not constrained near the center hexagon.");
        }
        var versusSize = textPointSize(semantic.matchTitle, "matchTitle");
        if (versusSize < 40 || versusSize > Number(artDirection.vs.fontSize) + 0.1) throw new Error("VS is outside its resolved fit range.");
        var versusColor = textColorChannels(semantic.matchTitle, "matchTitle");
        var expectedVersusColor = artDirection.vs.fill;
        var versusFillPassed = eccwRgbEqual(versusColor, expectedVersusColor, 1);
        if (runtimeDiagnostics) {
            runtimeDiagnostics.vsFill = {
                appliedPhotoshopTextLayerFill: cloneJsonValue(expectedVersusColor),
                measuredValidationFill: cloneJsonValue(versusColor),
                validationPassed: versusFillPassed
            };
        }
        if (!versusFillPassed) {
            throw new Error(
                "VS fill validation failed: expected=" + eccwRgbText(expectedVersusColor) +
                " actual=" + eccwRgbText(versusColor) + "."
            );
        }
        var leftNameBounds = assertLayerCenter(semantic.competitorLeftName, "competitorLeftName", 515, 925, 2);
        var rightNameBounds = assertLayerCenter(semantic.competitorRightName, "competitorRightName", 1405, 925, 2);
        var leftNameGeometry = textPositionAndSize("competitorLeftName", ECCW_PANEL_CANVAS_WIDTH, ECCW_PANEL_CANVAS_HEIGHT, ECCW_PANEL_LAYOUT_PRESET, artDirection);
        var rightNameGeometry = textPositionAndSize("competitorRightName", ECCW_PANEL_CANVAS_WIDTH, ECCW_PANEL_CANVAS_HEIGHT, ECCW_PANEL_LAYOUT_PRESET, artDirection);
        if (leftNameBounds.width > leftNameGeometry.maxWidth + 1 || rightNameBounds.width > rightNameGeometry.maxWidth + 1) throw new Error("A competitor name exceeds its resolved ECCW nameplate occupancy.");
        var minimumPadding = Number(artDirection.nameplates.minimumHorizontalPadding);
        if (
            leftNameBounds.left < 135 + minimumPadding || leftNameBounds.right > 900 - minimumPadding ||
            rightNameBounds.left < 1020 + minimumPadding || rightNameBounds.right > 1785 - minimumPadding ||
            leftNameBounds.top < 850 || leftNameBounds.bottom > 990 ||
            rightNameBounds.top < 850 || rightNameBounds.bottom > 990
        ) {
            throw new Error("A competitor name is outside its padded ECCW plate bounds.");
        }
        if (leftNameBounds.centerY < ECCW_PANEL_CANVAS_HEIGHT * 0.75 || rightNameBounds.centerY < ECCW_PANEL_CANVAS_HEIGHT * 0.75) {
            throw new Error("Competitor names are not in the bottom 25 percent of the ECCW canvas.");
        }
        var leftNameColor = textColorChannels(semantic.competitorLeftName, "competitorLeftName");
        var rightNameColor = textColorChannels(semantic.competitorRightName, "competitorRightName");
        if (
            leftNameColor.red < 254 || leftNameColor.green < 254 || leftNameColor.blue < 254 ||
            rightNameColor.red < 254 || rightNameColor.green < 254 || rightNameColor.blue < 254
        ) {
            throw new Error("ECCW competitor names must use solid white fills.");
        }
        var leftNameSize = textPointSize(semantic.competitorLeftName, "competitorLeftName");
        var rightNameSize = textPointSize(semantic.competitorRightName, "competitorRightName");
        if (
            leftNameSize < Number(artDirection.nameplates.minimumFontSize) ||
            rightNameSize < Number(artDirection.nameplates.minimumFontSize) ||
            leftNameSize > Number(artDirection.nameplates.maximumFontSize) ||
            rightNameSize > Number(artDirection.nameplates.maximumFontSize)
        ) throw new Error("A competitor name is outside its resolved nameplate font-size range.");
        var topElements = [
            { role: "showLogo", bounds: logoBounds },
            { role: "date", bounds: dateBounds }
        ];
        if (semantic.stipulation) {
            var stipulationBounds = assertLayerCenter(
                semantic.stipulation,
                "stipulation",
                960 + Number(artDirection.topPlate.stipulation.xOffset),
                250 + Number(artDirection.topPlate.stipulation.yOffset),
                2
            );
            topElements.push({ role: "stipulation", bounds: stipulationBounds });
        }
        for (var topElementIndex = 0; topElementIndex < topElements.length; topElementIndex++) {
            var topElement = topElements[topElementIndex];
            if (
                topElement.bounds.left < 720 || topElement.bounds.right > 1200 ||
                topElement.bounds.top < 0 || topElement.bounds.bottom > 270
            ) throw new Error(topElement.role + " is outside the configured ECCW top plate.");
            if (topElementIndex > 0 && topElement.bounds.top < topElements[topElementIndex - 1].bounds.bottom + 2) {
                throw new Error("Configured ECCW top-plate elements overlap: " + topElements[topElementIndex - 1].role + " and " + topElement.role + ".");
            }
        }
        if (!approvedFont || !approvedFont.postScriptName) throw new Error("The approved installed ECCW font was not recorded for preview validation.");
        var approvedPostScriptName = String(approvedFont.postScriptName).toLowerCase();
        var approvedTextRoles = ["competitorLeftName", "competitorRightName", "matchTitle", "date"];
        if (semantic.stipulation) approvedTextRoles.push("stipulation");
        for (var approvedTextIndex = 0; approvedTextIndex < approvedTextRoles.length; approvedTextIndex++) {
            var approvedTextRole = approvedTextRoles[approvedTextIndex];
            var actualPostScriptName;
            try { actualPostScriptName = String(semantic[approvedTextRole].textItem.font).toLowerCase(); }
            catch (error) { throw new Error("Could not verify the installed font for " + approvedTextRole + ": " + error.message); }
            if (actualPostScriptName !== approvedPostScriptName) throw new Error(approvedTextRole + " does not use the recorded approved installed font.");
        }

        var requestedAssetRoles = ownKeys(assets), requestedTextRoles = ownKeys(text);
        for (var assetIndex = 0; assetIndex < requestedAssetRoles.length; assetIndex++) {
            var assetRole = requestedAssetRoles[assetIndex];
            if (!semantic[assetRole] || !layerAndParentsVisible(semantic[assetRole])) throw new Error("Requested ECCW asset is missing or hidden: " + assetRole);
            assertLayerInsideCanvas(document, semantic[assetRole], assetRole);
        }
        for (var textIndex = 0; textIndex < requestedTextRoles.length; textIndex++) {
            var textRole = requestedTextRoles[textIndex];
            if (!semantic[textRole] || !isTextLayer(semantic[textRole]) || !layerAndParentsVisible(semantic[textRole])) throw new Error("Requested ECCW live text is missing or hidden: " + textRole);
            assertLayerInsideCanvas(document, semantic[textRole], textRole);
        }
    }
    function safeBaleStageErrorMessage(error) {
        var message = error && error.message ? String(error.message) : String(error);
        return message
            .replace(/[A-Za-z]:[\\\/][^\r\n]*/g, "[local path omitted]")
            .replace(/\\\\[^\\\r\n]+\\[^\r\n]*/g, "[local path omitted]")
            .replace(/\s+/g, " ");
    }
    function baleDomTypename(value) {
        try { return value && value.typename ? String(value.typename) : "(unavailable)"; }
        catch (_baleTypenameError) { return "(unavailable)"; }
    }
    function safeBaleDocumentName(document) {
        try {
            if (!document || !document.name) return "(unavailable)";
            return String(document.name)
                .replace(/[\x00-\x1f\x7f]/g, "")
                .replace(/\s+/g, " ")
                .substring(0, 160);
        } catch (_baleDocumentNameError) {
            return "(unavailable)";
        }
    }
    function baleDomOperationContext(operation, sourceObject, destinationObject, placement, sourceDocument, destinationDocument) {
        return 'operation="' + operation +
            '"; sourceTypename=' + baleDomTypename(sourceObject) +
            '; destinationTypename=' + baleDomTypename(destinationObject) +
            '; placement=' + placement +
            '; activeDocument="' + safeBaleDocumentName(currentDocumentOrNull()) +
            '"; sourceDocument="' + safeBaleDocumentName(sourceDocument) +
            '"; destinationDocument="' + safeBaleDocumentName(destinationDocument) + '"';
    }
    function duplicateBaleCcGroupFromSource(sourceDocument, sourceGroup, destinationDocument) {
        var imported = null, operationError = null, restorationError = null;
        var phase = "validating the Bale DOM references";
        var operation = "duplicate Bale group to destination document";
        var placement = "PLACEATBEGINNING";
        try {
            if (baleDomTypename(sourceDocument) !== "Document") {
                throw new Error("The Bale source reference is not a Document.");
            }
            if (baleDomTypename(sourceGroup) !== "LayerSet") {
                throw new Error("The Bale source group reference is not a LayerSet.");
            }
            if (baleDomTypename(destinationDocument) !== "Document") {
                throw new Error("The match-card destination reference is not a Document.");
            }
            if (sourceDocument === destinationDocument) {
                throw new Error("The Bale source and match-card destination must be different documents.");
            }

            phase = "activating the Bale source document";
            app.activeDocument = sourceDocument;
            if (app.activeDocument !== sourceDocument) {
                throw new Error("Photoshop did not make the Bale source document active.");
            }

            phase = "duplicating the Bale CC group";
            imported = sourceGroup.duplicate(destinationDocument, ElementPlacement.PLACEATBEGINNING);
            if (baleDomTypename(imported) !== "LayerSet") {
                throw new Error("Photoshop did not return the duplicated Bale group as a LayerSet.");
            }
        } catch (error) {
            operationError = new Error(
                "Bale CC import failed while " + phase + ": " +
                safeBaleStageErrorMessage(error) + " " +
                baleDomOperationContext(
                    operation,
                    sourceGroup,
                    destinationDocument,
                    placement,
                    sourceDocument,
                    destinationDocument
                )
            );
        } finally {
            try {
                if (baleDomTypename(destinationDocument) !== "Document") {
                    throw new Error("The match-card destination reference is not a Document.");
                }
                app.activeDocument = destinationDocument;
                if (app.activeDocument !== destinationDocument) {
                    throw new Error("Photoshop did not restore the destination match-card document.");
                }
            } catch (restoreError) {
                restorationError = new Error(
                    "Bale CC import failed while reactivating the destination match-card document: " +
                    safeBaleStageErrorMessage(restoreError) + " " +
                    baleDomOperationContext(
                        operation,
                        sourceGroup,
                        destinationDocument,
                        placement,
                        sourceDocument,
                        destinationDocument
                    )
                );
            }
        }

        if (operationError) {
            if (restorationError) throw new Error(operationError.message + " " + restorationError.message);
            throw operationError;
        }
        if (restorationError) throw restorationError;
        return imported;
    }
    function placeImportedBaleGroupInsideWrapper(importedGroup, wrapper, destinationDocument) {
        var anchor = null, attemptedDestination = wrapper;
        var operationError = null, cleanupError = null, restorationError = null;
        var phase = "validating the Bale wrapper DOM references";
        var operation = "move imported Bale group before temporary wrapper anchor";
        var placement = "PLACEBEFORE";
        try {
            if (baleDomTypename(importedGroup) !== "LayerSet") {
                throw new Error("The imported Bale group reference is not a LayerSet.");
            }
            if (baleDomTypename(wrapper) !== "LayerSet") {
                throw new Error("The Bale wrapper reference is not a LayerSet.");
            }
            if (baleDomTypename(destinationDocument) !== "Document") {
                throw new Error("The match-card destination reference is not a Document.");
            }

            app.activeDocument = destinationDocument;
            if (app.activeDocument !== destinationDocument) {
                throw new Error("Photoshop did not make the destination match-card document active.");
            }

            phase = "creating the temporary Bale wrapper anchor";
            anchor = wrapper.artLayers.add();
            attemptedDestination = anchor;
            if (baleDomTypename(anchor) !== "ArtLayer") {
                throw new Error("Photoshop did not create the Bale wrapper anchor as an ArtLayer.");
            }
            anchor.name = "__BALE_CC_IMPORT_ANCHOR__";

            phase = "moving the imported Bale group before the temporary wrapper anchor";
            importedGroup.move(anchor, ElementPlacement.PLACEBEFORE);
            if (
                baleDomTypename(importedGroup.parent) !== "LayerSet" ||
                safeLayerId(importedGroup.parent) !== safeLayerId(wrapper)
            ) {
                throw new Error("Photoshop did not place the imported Bale group inside the Bale wrapper.");
            }
        } catch (error) {
            operationError = new Error(
                "Bale CC import failed while " + phase + ": " +
                safeBaleStageErrorMessage(error) + " " +
                baleDomOperationContext(
                    operation,
                    importedGroup,
                    attemptedDestination,
                    placement,
                    destinationDocument,
                    destinationDocument
                )
            );
        } finally {
            if (anchor) {
                try {
                    anchor.remove();
                } catch (anchorCleanupError) {
                    cleanupError = new Error(
                        "Bale CC import failed while removing the temporary wrapper anchor: " +
                        safeBaleStageErrorMessage(anchorCleanupError) + " " +
                        baleDomOperationContext(
                            "remove temporary Bale wrapper anchor",
                            anchor,
                            wrapper,
                            "REMOVE",
                            destinationDocument,
                            destinationDocument
                        )
                    );
                }
            }
            try {
                app.activeDocument = destinationDocument;
                if (app.activeDocument !== destinationDocument) {
                    throw new Error("Photoshop did not restore the destination match-card document.");
                }
            } catch (restoreError) {
                restorationError = new Error(
                    "Bale CC import failed while reactivating the destination match-card document: " +
                    safeBaleStageErrorMessage(restoreError) + " " +
                    baleDomOperationContext(
                        operation,
                        importedGroup,
                        attemptedDestination,
                        placement,
                        destinationDocument,
                        destinationDocument
                    )
                );
            }
        }

        if (operationError) {
            if (cleanupError) operationError = new Error(operationError.message + " " + cleanupError.message);
            if (restorationError) operationError = new Error(operationError.message + " " + restorationError.message);
            throw operationError;
        }
        if (cleanupError) {
            if (restorationError) throw new Error(cleanupError.message + " " + restorationError.message);
            throw cleanupError;
        }
        if (restorationError) throw restorationError;
        return importedGroup;
    }
    function importBaleCcGroup(input, targetDocument) {
        var baleCc = configuredBaleCc(input, true), folder = matchWorkingFolder(input), packageFile = childFile(folder, baleCc.packageFileName);
        if (!packageFile.exists) throw new Error("Missing Bale CC package: " + baleCc.packageFileName);
        var previous = currentDocumentOrNull(), packageDocument = null, ownedDocument = false, imported = null, wrapper = null, previousDialogs = null;
        try { previousDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO; } catch (_importDialogReadError) {}
        try {
            packageDocument = findOpenDocumentForFile(packageFile);
            if (!packageDocument) { packageDocument = app.open(packageFile); ownedDocument = true; }
            else if (!packageDocument.saved) throw new Error("The Bale CC package is already open with unsaved changes; save or close it before running this job.");
            var matches = [];
            findNamedGroups(packageDocument.layers, baleCc.groupName, matches);
            if (matches.length !== 1) throw new Error('Expected exactly one Bale CC group named "' + baleCc.groupName + '"; found ' + matches.length + ".");
            app.activeDocument = targetDocument;
            wrapper = targetDocument.layerSets.add();
            wrapper.name = "00 - BALE CC";
            try { wrapper.blendMode = BlendMode.PASSTHROUGH; } catch (_balePassThroughError) {}
            imported = duplicateBaleCcGroupFromSource(packageDocument, matches[0], targetDocument);
            placeImportedBaleGroupInsideWrapper(imported, wrapper, targetDocument);
            imported.name = baleCc.groupName;
            return { wrapper: wrapper, sourceGroup: imported };
        } finally {
            if (ownedDocument && packageDocument) try { packageDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_importPackageCloseError) {}
            if (previousDialogs !== null) try { app.displayDialogs = previousDialogs; } catch (_importDialogRestoreError) {}
            if (!imported) restoreActiveDocument(previous);
            else try { app.activeDocument = targetDocument; } catch (_activateTargetAfterBaleError) {}
        }
    }
    function importBaleCcSourceIntoWrapper(input, targetDocument, wrapper) {
        var baleCc = configuredBaleCc(input, true), folder = matchWorkingFolder(input), packageFile = childFile(folder, baleCc.packageFileName);
        if (!packageFile.exists) throw new Error("Missing Bale CC package: " + baleCc.packageFileName);
        var previous = currentDocumentOrNull(), packageDocument = null, ownedDocument = false, imported = null, previousDialogs = null;
        try { previousDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO; } catch (_repairBaleDialogReadError) {}
        try {
            packageDocument = findOpenDocumentForFile(packageFile);
            if (!packageDocument) { packageDocument = app.open(packageFile); ownedDocument = true; }
            else if (!packageDocument.saved) throw new Error("The Bale CC package is already open with unsaved changes; save or close it before running this job.");
            var matches = [];
            findNamedGroups(packageDocument.layers, baleCc.groupName, matches);
            if (matches.length !== 1) throw new Error('Expected exactly one Bale CC group named "' + baleCc.groupName + '"; found ' + matches.length + ".");
            imported = duplicateBaleCcGroupFromSource(packageDocument, matches[0], targetDocument);
            placeImportedBaleGroupInsideWrapper(imported, wrapper, targetDocument);
            imported.name = baleCc.groupName;
            return imported;
        } finally {
            if (ownedDocument && packageDocument) try { packageDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_repairBalePackageCloseError) {}
            if (previousDialogs !== null) try { app.displayDialogs = previousDialogs; } catch (_repairBaleDialogRestoreError) {}
            if (!imported) restoreActiveDocument(previous);
            else try { app.activeDocument = targetDocument; } catch (_repairBaleActivateError) {}
        }
    }
    function resolveOptionalLayerByManifestEntry(document, role, entry) {
        var matches = [], wantedId = Number(entry.id);
        findLayerRecursive(document.layers, function (layer) { return safeLayerId(layer) === wantedId; }, [], matches);
        if (!matches.length) return null;
        if (matches.length !== 1) throw new Error("Manifest semantic role " + role + " resolves to more than one layer ID.");
        if (matches[0].layer.name !== entry.name || matches[0].layer.typename !== entry.typename || safeLayerKind(matches[0].layer) !== entry.kind) throw new Error("Manifest semantic role " + role + " no longer matches its recorded layer metadata.");
        return matches[0];
    }
    function resolveLayerByManifestEntry(document, role, entry) {
        var resolved = resolveOptionalLayerByManifestEntry(document, role, entry);
        if (!resolved) throw new Error("Manifest semantic role " + role + " does not resolve to a layer ID.");
        return resolved;
    }
    function verifyDuplicatedSemanticLayer(layer, role, entry) {
        if (!layer || layer.name !== entry.name || layer.typename !== entry.typename || safeLayerKind(layer) !== entry.kind) throw new Error("Duplicated semantic role " + role + " no longer matches the manifest metadata.");
    }
    function semanticLayerEntry(document, layer) {
        var layerId = safeLayerId(layer), matches = [];
        if (!layerId) throw new Error("A semantic layer has no readable numeric ID: " + layer.name);
        findLayerRecursive(document.layers, function (candidate) { return safeLayerId(candidate) === layerId; }, [], matches);
        if (matches.length !== 1) throw new Error("Could not determine a unique index path for semantic layer: " + layer.name);
        return { id: layerId, name: layer.name, typename: layer.typename, kind: safeLayerKind(layer), indexPath: matches[0].indexPath };
    }
    function captureSemanticLayers(document, references) {
        var result = {};
        for (var role in references) if (own(references, role) && references[role]) result[role] = semanticLayerEntry(document, references[role]);
        return result;
    }
    function utcTimestamp() {
        var date = new Date();
        function pad(value, width) { var text = String(value); while (text.length < width) text = "0" + text; return text; }
        return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1, 2) + "-" + pad(date.getUTCDate(), 2) + "T" + pad(date.getUTCHours(), 2) + ":" + pad(date.getUTCMinutes(), 2) + ":" + pad(date.getUTCSeconds(), 2) + "." + pad(date.getUTCMilliseconds(), 3) + "Z";
    }
    function cloneJsonValue(value) {
        if (value === null || typeof value !== "object") return value;
        var result, i, key;
        if (value instanceof Array) {
            result = [];
            for (i = 0; i < value.length; i++) result.push(cloneJsonValue(value[i]));
            return result;
        }
        result = {};
        for (key in value) if (own(value, key)) result[key] = cloneJsonValue(value[key]);
        return result;
    }
    function mergeOwn(target, changes) {
        if (!changes) return target;
        for (var key in changes) if (own(changes, key)) target[key] = cloneJsonValue(changes[key]);
        return target;
    }
    function mergePlacementMap(target, changes) {
        if (!changes) return target;
        var roles = ownKeys(changes);
        for (var i = 0; i < roles.length; i++) {
            if (!own(target, roles[i])) target[roles[i]] = {};
            mergeOwn(target[roles[i]], changes[roles[i]]);
        }
        return target;
    }
    function mergedPlacement(previousPlacement, changes) {
        var result = previousPlacement ? cloneJsonValue(previousPlacement) : {};
        return mergeOwn(result, changes || {});
    }
    function themeColorsFromStyle(style) {
        return {
            primaryColor: cloneJsonValue(style.primaryColor),
            secondaryColor: cloneJsonValue(style.secondaryColor),
            accentColor: cloneJsonValue(style.accentColor),
            metallicColor: cloneJsonValue(style.metallicColor)
        };
    }
    function matchSemanticRoles() {
        var roles = [
            "baleCc", "baleCcSourceGroup", "templateBackgroundLayer", "templateBackground", "atmosphere",
            "framesAndPanels", "competitorRenders", "championshipAndBelt", "matchTitleGroup",
            "eventInformation", "showLogoGroup", "finishingEffects", "fullFrameAtmosphere",
            "lowerThirdPanel", "titleBacking", "showLogoPlate", "lowerLightStrip", "topBorder",
            "bottomBorder", "finishingGlow"
        ];
        var i;
        for (i = 0; i < MATCH_ASSET_ROLES.length; i++) {
            roles.push(MATCH_ASSET_ROLES[i]);
            roles.push(MATCH_ASSET_ROLES[i] + "ClippingBase");
        }
        for (i = 0; i < MATCH_TEXT_ROLES.length; i++) roles.push(MATCH_TEXT_ROLES[i]);
        return roles;
    }
    function validateSemanticManifestEntry(entry, label) {
        assertAllowedKeys(requirePlainObject(entry, label), ["id", "name", "typename", "kind", "indexPath"], label);
        var id = Number(entry.id);
        if (!isFinite(id) || id <= 0 || Math.floor(id) !== id) throw new Error(label + ".id must be a positive integer.");
        requireString(entry.name, label + ".name", 1, 255, false);
        requireString(entry.typename, label + ".typename", 1, 100, false);
        if (!own(entry, "kind") || typeof entry.kind !== "string") throw new Error(label + ".kind must be a string.");
        requireString(entry.kind, label + ".kind", 1, 100, false);
        if (!(entry.indexPath instanceof Array) || entry.indexPath.length < 1 || entry.indexPath.length > 50) throw new Error(label + ".indexPath is invalid.");
        for (var i = 0; i < entry.indexPath.length; i++) {
            var index = Number(entry.indexPath[i]);
            if (!isFinite(index) || index < 0 || Math.floor(index) !== index) throw new Error(label + ".indexPath contains an invalid index.");
        }
    }
    function validateManifestPlacements(value) {
        assertAllowedKeys(requirePlainObject(value, "manifest placements"), MATCH_ASSET_ROLES, "manifest placements");
        var keys = ownKeys(value);
        for (var i = 0; i < keys.length; i++) validatePlacement(value[keys[i]], "manifest placements." + keys[i]);
    }
    function validateRecordedBounds(value, label) {
        assertAllowedKeys(requirePlainObject(value, label), ["left", "top", "right", "bottom", "width", "height", "centerX", "centerY", "visibleLeft", "visibleTop", "visibleRight", "visibleBottom", "visibleWidth", "visibleHeight", "visibleArea"], label);
        var keys = ownKeys(value);
        if (!keys.length) throw new Error(label + " must contain measured bounds.");
        for (var i = 0; i < keys.length; i++) {
            var number = Number(value[keys[i]]);
            if (!isFinite(number) || Math.abs(number) > 100000000) throw new Error(label + "." + keys[i] + " must be a finite measured value.");
        }
    }
    function validateEccwLogoPlacementDiagnostics(value) {
        var label = "manifest artDirection.logoPlacement";
        var legacy = own(value, "sourceFullImageWidth");
        var numericKeys = legacy ? [
            "sourceFullImageWidth", "sourceAlphaVisibleWidth", "requestedAlphaVisibleWidth",
            "initialPlacedAlphaVisibleWidth", "appliedScaleFactor", "appliedScalePercentage",
            "placementCorrectionFactor", "placementCorrectionPercentage",
            "measuredPlacedAlphaVisibleWidth", "differenceFromRequestedWidth", "verificationTolerance"
        ] : [
            "sourceFullWidth", "sourceAlphaVisibleWidth", "requestedAlphaVisibleWidth",
            "initialPlacedAlphaVisibleWidth", "nominalScaleFactor", "nominalScalePercent",
            "measuredWidthAfterNominalScale", "cumulativeAppliedScaleFactor",
            "finalMeasuredAlphaVisibleWidth", "difference", "tolerance"
        ];
        var allowed = numericKeys.slice(0);
        allowed.push("verificationPassed");
        allowed.push("postScaleContainmentOrNormalization");
        if (!legacy) {
            allowed.push("initialPlacementTransform");
            allowed.push("correctionFactors");
            allowed.push("correctionIterations");
            allowed.push("scaleAnchor");
        }
        assertAllowedKeys(requirePlainObject(value, label), allowed, label);
        for (var numericIndex = 0; numericIndex < numericKeys.length; numericIndex++) {
            var numericKey = numericKeys[numericIndex];
            if (!own(value, numericKey) || !isFinite(Number(value[numericKey]))) throw new Error(label + "." + numericKey + " must be a finite number.");
            var permitsZero = numericKey === "differenceFromRequestedWidth" || numericKey === "difference";
            if ((!permitsZero && Number(value[numericKey]) <= 0) || (permitsZero && Number(value[numericKey]) < 0)) {
                throw new Error(label + "." + numericKey + (permitsZero ? " must not be negative." : " must be positive."));
            }
        }
        if (!legacy) {
            if (value.initialPlacementTransform !== null) {
                if (!(value.initialPlacementTransform instanceof Array) || value.initialPlacementTransform.length < 1 || value.initialPlacementTransform.length > 32) {
                    throw new Error(label + ".initialPlacementTransform must be null or a bounded numeric array.");
                }
                for (var transformIndex = 0; transformIndex < value.initialPlacementTransform.length; transformIndex++) {
                    if (!isFinite(Number(value.initialPlacementTransform[transformIndex]))) throw new Error(label + ".initialPlacementTransform contains a non-finite value.");
                }
            }
            if (!(value.correctionFactors instanceof Array) || value.correctionFactors.length > ECCW_LOGO_MAX_CORRECTION_ITERATIONS) {
                throw new Error(label + ".correctionFactors exceeds the bounded correction count.");
            }
            for (var correctionIndex = 0; correctionIndex < value.correctionFactors.length; correctionIndex++) {
                if (!isFinite(Number(value.correctionFactors[correctionIndex])) || Number(value.correctionFactors[correctionIndex]) <= 0) {
                    throw new Error(label + ".correctionFactors contains an invalid factor.");
                }
            }
            if (
                !isFinite(Number(value.correctionIterations)) ||
                Math.floor(Number(value.correctionIterations)) !== Number(value.correctionIterations) ||
                Number(value.correctionIterations) !== value.correctionFactors.length
            ) throw new Error(label + ".correctionIterations does not match correctionFactors.");
            if (Number(value.tolerance) !== ECCW_LOGO_WIDTH_VERIFICATION_TOLERANCE) throw new Error(label + ".tolerance must remain 1 px.");
            if (value.scaleAnchor !== "MIDDLECENTER") throw new Error(label + ".scaleAnchor is invalid.");
        }
        if (value.verificationPassed !== true) throw new Error(label + ".verificationPassed must be true for a completed manifest.");
        if (!(value.postScaleContainmentOrNormalization instanceof Array)) throw new Error(label + ".postScaleContainmentOrNormalization must be an array.");
        for (var actionIndex = 0; actionIndex < value.postScaleContainmentOrNormalization.length; actionIndex++) {
            requireString(value.postScaleContainmentOrNormalization[actionIndex], label + ".postScaleContainmentOrNormalization entry", 1, 160, false);
        }
    }
    function validateEccwVsFillDiagnostics(value) {
        var label = "manifest artDirection.vsFill";
        assertAllowedKeys(requirePlainObject(value, label), [
            "requestedFill", "presetDefaultFill", "finalResolvedFill",
            "appliedPhotoshopTextLayerFill", "measuredValidationFill", "validationPassed"
        ], label);
        if (value.requestedFill !== null) {
            validateRgb(value.requestedFill, label + ".requestedFill");
            if (!eccwRgbEqual(value.requestedFill, ECCW_VS_APPROVED_FILL, 0)) throw new Error(label + ".requestedFill is not preset-approved.");
        }
        validateRgb(value.presetDefaultFill, label + ".presetDefaultFill");
        validateRgb(value.finalResolvedFill, label + ".finalResolvedFill");
        validateRgb(value.appliedPhotoshopTextLayerFill, label + ".appliedPhotoshopTextLayerFill");
        var measured = requirePlainObject(value.measuredValidationFill, label + ".measuredValidationFill");
        assertAllowedKeys(measured, ["red", "green", "blue"], label + ".measuredValidationFill");
        var channels = ["red", "green", "blue"];
        for (var channelIndex = 0; channelIndex < channels.length; channelIndex++) {
            var channel = channels[channelIndex], measuredChannel = Number(measured[channel]);
            if (!own(measured, channel) || !isFinite(measuredChannel) || measuredChannel < 0 || measuredChannel > 255) {
                throw new Error(label + ".measuredValidationFill." + channel + " is invalid.");
            }
        }
        if (
            !eccwRgbEqual(value.presetDefaultFill, ECCW_VS_APPROVED_FILL, 0) ||
            !eccwRgbEqual(value.finalResolvedFill, ECCW_VS_APPROVED_FILL, 0) ||
            !eccwRgbEqual(value.appliedPhotoshopTextLayerFill, ECCW_VS_APPROVED_FILL, 0)
        ) throw new Error(label + " does not use the canonical preset fill.");
        if (!eccwRgbEqual(value.measuredValidationFill, ECCW_VS_APPROVED_FILL, 1)) throw new Error(label + ".measuredValidationFill failed read-back validation.");
        if (value.validationPassed !== true) throw new Error(label + ".validationPassed must be true for a completed manifest.");
    }
    function validateManifestArtDirection(value) {
        assertAllowedKeys(requirePlainObject(value, "manifest artDirection"), [
            "requested", "resolved", "installedFont", "finalTextBounds",
            "competitorVisibleBounds", "masks", "adjustments", "logoPlacement", "vsFill"
        ], "manifest artDirection");
        validateEccwArtDirection(value.requested, "manifest artDirection.requested");
        validateEccwArtDirection(value.resolved, "manifest artDirection.resolved");
        assertAllowedKeys(requirePlainObject(value.installedFont, "manifest artDirection.installedFont"), ["family", "style", "postScriptName"], "manifest artDirection.installedFont");
        requireString(value.installedFont.family, "manifest installed font family", 0, 160, true);
        requireString(value.installedFont.style, "manifest installed font style", 0, 160, true);
        requireString(value.installedFont.postScriptName, "manifest installed font PostScript name", 1, 160, false);
        assertAllowedKeys(requirePlainObject(value.finalTextBounds, "manifest finalTextBounds"), MATCH_TEXT_ROLES, "manifest finalTextBounds");
        var textRoles = ownKeys(value.finalTextBounds);
        for (var textIndex = 0; textIndex < textRoles.length; textIndex++) validateRecordedBounds(value.finalTextBounds[textRoles[textIndex]], "manifest finalTextBounds." + textRoles[textIndex]);
        assertAllowedKeys(requirePlainObject(value.competitorVisibleBounds, "manifest competitorVisibleBounds"), ["competitorLeft", "competitorRight"], "manifest competitorVisibleBounds");
        validateRecordedBounds(value.competitorVisibleBounds.competitorLeft, "manifest competitorVisibleBounds.competitorLeft");
        validateRecordedBounds(value.competitorVisibleBounds.competitorRight, "manifest competitorVisibleBounds.competitorRight");
        assertAllowedKeys(requirePlainObject(value.masks, "manifest masks"), ["competitorLeft", "competitorRight"], "manifest masks");
        assertAllowedKeys(requirePlainObject(value.adjustments, "manifest adjustments"), ["competitorLeft", "competitorRight"], "manifest adjustments");
        var competitorRoles = ["competitorLeft", "competitorRight"];
        for (var roleIndex = 0; roleIndex < competitorRoles.length; roleIndex++) {
            var role = competitorRoles[roleIndex], mask = value.masks[role], adjustment = value.adjustments[role];
            assertAllowedKeys(requirePlainObject(mask, "manifest mask " + role), ["exists", "cutoffY"], "manifest mask " + role);
            if (mask.exists !== true) throw new Error("Manifest mandatory mask must exist for " + role + ".");
            validateOptionalRange(mask, "cutoffY", 700, 950, "manifest mask " + role);
            assertAllowedKeys(requirePlainObject(adjustment, "manifest adjustment " + role), ["applied", "brightness", "contrast", "layerId"], "manifest adjustment " + role);
            if (typeof adjustment.applied !== "boolean") throw new Error("Manifest adjustment applied must be boolean for " + role + ".");
            if (own(adjustment, "brightness")) validateOptionalRange(adjustment, "brightness", -100, 100, "manifest adjustment " + role);
            if (own(adjustment, "contrast")) validateOptionalRange(adjustment, "contrast", -100, 100, "manifest adjustment " + role);
            if (own(adjustment, "layerId")) {
                var adjustmentLayerId = Number(adjustment.layerId);
                if (!isFinite(adjustmentLayerId) || adjustmentLayerId <= 0 || Math.floor(adjustmentLayerId) !== adjustmentLayerId) throw new Error("Manifest adjustment layerId is invalid for " + role + ".");
            }
        }
        if (own(value, "logoPlacement")) validateEccwLogoPlacementDiagnostics(value.logoPlacement);
        if (own(value, "vsFill")) validateEccwVsFillDiagnostics(value.vsFill);
    }
    function validateMatchCardManifest(manifest) {
        var allowed = [
            "schemaVersion", "outputPsdName", "outputPreviewName", "outputManifestName",
            "templateBackground", "briefName", "layoutPreset", "canvas", "styleDescription",
            "themeColors", "styleFonts", "baleCc", "semanticLayers", "assets", "text",
            "placements", "artDirection", "createdAt", "updatedAt", "parentManifestName", "warnings"
        ];
        assertAllowedKeys(requirePlainObject(manifest, "match-card manifest"), allowed, "match-card manifest");
        if (Number(manifest.schemaVersion) !== 1) throw new Error("Unsupported match-card manifest schemaVersion.");
        validateMatchFileName(manifest.outputPsdName, [".psd"], "manifest outputPsdName");
        validateMatchFileName(manifest.outputPreviewName, [".png"], "manifest outputPreviewName");
        validateMatchFileName(manifest.outputManifestName, [".matchcard.json"], "manifest outputManifestName");
        validateTemplateBackground(manifest.templateBackground);
        requireString(manifest.briefName, "manifest briefName", 1, 200, false);
        if (!valueInList(manifest.layoutPreset, MATCH_LAYOUT_PRESETS)) throw new Error("Manifest layoutPreset is unsupported.");
        validateCanvas(manifest.canvas);
        requireString(manifest.styleDescription, "manifest styleDescription", 1, 500, false);
        assertAllowedKeys(requirePlainObject(manifest.themeColors, "manifest themeColors"), ["primaryColor", "secondaryColor", "accentColor", "metallicColor"], "manifest themeColors");
        validateRgb(manifest.themeColors.primaryColor, "manifest themeColors.primaryColor");
        validateRgb(manifest.themeColors.secondaryColor, "manifest themeColors.secondaryColor");
        validateRgb(manifest.themeColors.accentColor, "manifest themeColors.accentColor");
        validateRgb(manifest.themeColors.metallicColor, "manifest themeColors.metallicColor");
        if (own(manifest, "styleFonts")) {
            assertAllowedKeys(requirePlainObject(manifest.styleFonts, "manifest styleFonts"), MATCH_FONT_ROLES, "manifest styleFonts");
            var fontKeys = ownKeys(manifest.styleFonts);
            for (var fontIndex = 0; fontIndex < fontKeys.length; fontIndex++) requireString(manifest.styleFonts[fontKeys[fontIndex]], "manifest styleFonts." + fontKeys[fontIndex], 1, 100, false);
        }
        assertAllowedKeys(requirePlainObject(manifest.baleCc, "manifest baleCc"), ["packageFileName", "groupName"], "manifest baleCc");
        validateMatchFileName(manifest.baleCc.packageFileName, [".psd"], "manifest Bale CC packageFileName");
        requireString(manifest.baleCc.groupName, "manifest Bale CC groupName", 1, 255, false);
        validateAssetMap(manifest.assets, "manifest assets", false);
        validateTextMap(manifest.text, "manifest text");
        if (manifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            if (own(manifest, "artDirection")) validateManifestArtDirection(manifest.artDirection);
            if (Number(manifest.canvas.width) !== ECCW_PANEL_CANVAS_WIDTH || Number(manifest.canvas.height) !== ECCW_PANEL_CANVAS_HEIGHT) {
                throw new Error("The ECCW manifest canvas must remain exactly 1920x1080.");
            }
            if (String(manifest.templateBackground.fileName).toLowerCase() !== ECCW_PANEL_TEMPLATE_FILE_NAME.toLowerCase()) {
                throw new Error("The ECCW manifest does not reference its dedicated template background.");
            }
            var eccwManifestAssets = ownKeys(manifest.assets), allowedEccwManifestAssets = ["competitorLeft", "competitorRight", "showLogo"];
            for (var eccwManifestAssetIndex = 0; eccwManifestAssetIndex < eccwManifestAssets.length; eccwManifestAssetIndex++) {
                if (!valueInList(eccwManifestAssets[eccwManifestAssetIndex], allowedEccwManifestAssets)) throw new Error("The ECCW manifest contains an unsupported asset role.");
            }
            var requiredEccwManifestText = ["competitorLeftName", "competitorRightName", "matchTitle", "date"];
            var allowedEccwManifestText = requiredEccwManifestText.slice(0);
            allowedEccwManifestText.push("stipulation");
            var eccwManifestText = ownKeys(manifest.text);
            for (var eccwRequiredTextIndex = 0; eccwRequiredTextIndex < requiredEccwManifestText.length; eccwRequiredTextIndex++) {
                if (!own(manifest.text, requiredEccwManifestText[eccwRequiredTextIndex])) throw new Error("The ECCW manifest is missing required live text.");
            }
            for (var eccwManifestTextIndex = 0; eccwManifestTextIndex < eccwManifestText.length; eccwManifestTextIndex++) {
                if (!valueInList(eccwManifestText[eccwManifestTextIndex], allowedEccwManifestText)) throw new Error("The ECCW manifest contains an unsupported text role.");
            }
            if (String(manifest.text.matchTitle).replace(/^\s+|\s+$/g, "").toUpperCase() !== "VS") throw new Error('The ECCW manifest matchTitle must remain "VS".');
        } else if (own(manifest, "artDirection")) throw new Error("Only the ECCW manifest may record artDirection.");
        validateManifestPlacements(manifest.placements);
        assertAllowedKeys(requirePlainObject(manifest.semanticLayers, "manifest semanticLayers"), matchSemanticRoles(), "manifest semanticLayers");
        var semanticKeys = ownKeys(manifest.semanticLayers), seenSemanticIds = {}, seenSemanticPaths = {};
        if (!own(manifest.semanticLayers, "baleCc") || !own(manifest.semanticLayers, "baleCcSourceGroup") || !own(manifest.semanticLayers, "templateBackgroundLayer")) throw new Error("Manifest is missing mandatory Bale CC or template-background semantic roles.");
        for (var semanticIndex = 0; semanticIndex < semanticKeys.length; semanticIndex++) {
            var semanticRole = semanticKeys[semanticIndex], semanticEntry = manifest.semanticLayers[semanticRole];
            validateSemanticManifestEntry(semanticEntry, "manifest semanticLayers." + semanticRole);
            var semanticIdKey = String(Number(semanticEntry.id)), semanticPathKey = semanticEntry.indexPath.join("/");
            if (own(seenSemanticIds, semanticIdKey)) throw new Error("Manifest semantic roles " + seenSemanticIds[semanticIdKey] + " and " + semanticRole + " share one layer ID.");
            if (own(seenSemanticPaths, semanticPathKey)) throw new Error("Manifest semantic roles " + seenSemanticPaths[semanticPathKey] + " and " + semanticRole + " share one index path.");
            seenSemanticIds[semanticIdKey] = semanticRole;
            seenSemanticPaths[semanticPathKey] = semanticRole;
        }
        requireString(manifest.createdAt, "manifest createdAt", 1, 60, false);
        if (own(manifest, "updatedAt") && manifest.updatedAt !== null) requireString(manifest.updatedAt, "manifest updatedAt", 1, 60, false);
        if (own(manifest, "parentManifestName") && manifest.parentManifestName !== null) validateMatchFileName(manifest.parentManifestName, [".matchcard.json"], "manifest parentManifestName");
        if (!(manifest.warnings instanceof Array) || manifest.warnings.length > 100) throw new Error("Manifest warnings must be an array of at most 100 strings.");
        for (var warningIndex = 0; warningIndex < manifest.warnings.length; warningIndex++) requireString(manifest.warnings[warningIndex], "manifest warning", 0, 1000, true);
        return manifest;
    }
    function writeMatchCardManifest(file, manifest) {
        if (file.exists) throw new Error("Manifest output already exists: " + file.name);
        writeUtf8(file.fsName, stringify(manifest));
        if (!file.exists) throw new Error("Photoshop worker did not create the match-card manifest.");
    }
    function measuredBoundsRecord(bounds) {
        var geometry = rect(bounds);
        return {
            left: Number(bounds.left),
            top: Number(bounds.top),
            right: Number(bounds.right),
            bottom: Number(bounds.bottom),
            width: geometry.width,
            height: geometry.height,
            centerX: geometry.centerX,
            centerY: geometry.centerY
        };
    }
    function directLayerNamed(group, name) {
        for (var i = 0; i < group.layers.length; i++) if (group.layers[i].name === name) return group.layers[i];
        return null;
    }
    function buildEccwArtDirectionRecord(document, semantic, groups, requested, resolved, approvedFont, logoPlacementDiagnostics, vsFillRuntimeDiagnostics) {
        var textBounds = {}, textRoles = ["competitorLeftName", "competitorRightName", "matchTitle", "date", "stipulation"];
        for (var textIndex = 0; textIndex < textRoles.length; textIndex++) {
            var textRole = textRoles[textIndex];
            if (!semantic[textRole]) continue;
            var bounds = safeTransformBounds(semantic[textRole]);
            if (!bounds) throw new Error("Could not record final measured text bounds for " + textRole + ".");
            textBounds[textRole] = measuredBoundsRecord(bounds);
        }
        var visibleBounds = {}, masks = {}, adjustments = {}, competitorRoles = ["competitorLeft", "competitorRight"];
        for (var roleIndex = 0; roleIndex < competitorRoles.length; roleIndex++) {
            var role = competitorRoles[roleIndex], direction = resolved[role], cutoffY = Number(direction.cutoffY);
            var unmaskedBounds = measureBoundsBehindEccwMask(document, semantic[role], role, cutoffY), unmasked = measuredBoundsRecord(unmaskedBounds);
            unmasked.visibleLeft = Math.max(0, unmasked.left);
            unmasked.visibleTop = Math.max(0, unmasked.top);
            unmasked.visibleRight = Math.min(ECCW_PANEL_CANVAS_WIDTH, unmasked.right);
            unmasked.visibleBottom = Math.min(cutoffY, unmasked.bottom);
            unmasked.visibleWidth = Math.max(0, unmasked.visibleRight - unmasked.visibleLeft);
            unmasked.visibleHeight = Math.max(0, unmasked.visibleBottom - unmasked.visibleTop);
            unmasked.visibleArea = unmasked.visibleWidth * unmasked.visibleHeight;
            visibleBounds[role] = unmasked;
            masks[role] = { exists: layerHasUserMask(semantic[role]), cutoffY: cutoffY };
            var adjustmentName = MATCH_ASSET_LAYER_NAMES[role] + " - BRIGHTNESS CONTRAST";
            var adjustmentLayer = directLayerNamed(groups.competitorRenders, adjustmentName);
            var requestedAdjustment = own(direction, "brightness") || own(direction, "contrast");
            if (requestedAdjustment && (!adjustmentLayer || !Boolean(adjustmentLayer.grouped))) {
                throw new Error("The non-destructive brightness/contrast adjustment is missing or unclipped for " + role + ".");
            }
            if (!requestedAdjustment && adjustmentLayer) throw new Error("An unrequested brightness/contrast adjustment exists for " + role + ".");
            adjustments[role] = { applied: Boolean(adjustmentLayer) };
            if (own(direction, "brightness")) adjustments[role].brightness = Number(direction.brightness);
            if (own(direction, "contrast")) adjustments[role].contrast = Number(direction.contrast);
            if (adjustmentLayer) adjustments[role].layerId = safeLayerId(adjustmentLayer);
        }
        var record = {
            requested: cloneJsonValue(requested || {}),
            resolved: cloneJsonValue(resolved),
            installedFont: {
                family: String(approvedFont.family || ""),
                style: String(approvedFont.style || ""),
                postScriptName: String(approvedFont.postScriptName)
            },
            finalTextBounds: textBounds,
            competitorVisibleBounds: visibleBounds,
            masks: masks,
            adjustments: adjustments
        };
        if (logoPlacementDiagnostics) record.logoPlacement = cloneJsonValue(logoPlacementDiagnostics);
        record.vsFill = buildEccwVsFillDiagnostics(requested || {}, resolved, vsFillRuntimeDiagnostics || null);
        return record;
    }
    function buildCreateManifest(input, payload, semanticLayers, warnings, artDirectionRecord) {
        var baleCc = configuredBaleCc(input, true);
        var manifest = {
            schemaVersion: 1,
            outputPsdName: payload.outputPsdName,
            outputPreviewName: payload.outputPreviewName,
            outputManifestName: payload.outputManifestName,
            templateBackground: cloneJsonValue(payload.templateBackground),
            briefName: payload.briefName,
            layoutPreset: payload.style.layoutPreset,
            canvas: cloneJsonValue(payload.canvas),
            styleDescription: payload.style.description,
            themeColors: themeColorsFromStyle(payload.style),
            styleFonts: payload.style.fonts ? cloneJsonValue(payload.style.fonts) : {},
            baleCc: { packageFileName: baleCc.packageFileName, groupName: baleCc.groupName },
            semanticLayers: semanticLayers,
            assets: cloneJsonValue(payload.assets),
            text: cloneJsonValue(payload.text),
            placements: payload.placements ? cloneJsonValue(payload.placements) : {},
            createdAt: utcTimestamp(),
            updatedAt: null,
            parentManifestName: null,
            warnings: warnings.slice(0)
        };
        if (artDirectionRecord) manifest.artDirection = cloneJsonValue(artDirectionRecord);
        return manifest;
    }
    function assertCreatePreflightReady(preflight) {
        var reasons = [];
        if (preflight.missingFiles.length) reasons.push("Missing files: " + preflight.missingFiles.join(", "));
        if (preflight.existingOutputs.length) reasons.push("Existing outputs: " + preflight.existingOutputs.join(", "));
        if (!preflight.baleCc.available) reasons.push(preflight.baleCc.issue || "Bale CC is unavailable.");
        if (reasons.length) throw new Error(reasons.join(" "));
    }
    function createMatchCard(input) {
        var payload = validateCreateMatchCardPayload(input.payload || {}), folder = matchWorkingFolder(input);
        configuredBaleCc(input, true);
        var warnings = [];
        var requestedArtDirection = payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && own(payload, "artDirection") ? cloneJsonValue(payload.artDirection) : {};
        var artDirection = payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET ? resolvedEccwArtDirection(payload.artDirection || {}) : null;
        if (artDirection && own(artDirection.topPlate.stipulation, "text")) payload.text.stipulation = artDirection.topPlate.stipulation.text;
        applyDeterministicEccwPlacements(payload, warnings, artDirection);
        var stage = "preflight", preflight = preflightCreateMatchCard(input, payload);
        assertCreatePreflightReady(preflight);
        var outputPsd = childFile(folder, payload.outputPsdName), outputPreview = childFile(folder, payload.outputPreviewName), outputManifest = childFile(folder, payload.outputManifestName);
        var previous = currentDocumentOrNull(), document = null, previewDocument = null, attemptedOutputs = [], placementDiagnostics = {};
        var previousDialogs = null;
        try { previousDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO; } catch (_createDialogReadError) {}
        try {
            stage = "create document";
            document = app.documents.add(UnitValue(payload.canvas.width, "px"), UnitValue(payload.canvas.height, "px"), payload.canvas.resolution, payload.outputPsdName.replace(/\.psd$/i, ""), NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            app.activeDocument = document;
            var bootstrapLayer = document.layers.length === 1 && document.layers[0].typename === "ArtLayer" ? document.layers[0] : null;
            var groups = createMatchCardGroups(document, payload.style.layoutPreset), semantic = {}, groupRole;
            if (bootstrapLayer) bootstrapLayer.remove();
            for (groupRole in groups) if (own(groups, groupRole)) semantic[groupRole] = groups[groupRole];
            if (payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) ensureEccwGroupOrder(document, groups);

            stage = "import Bale CC";
            var importedBale = importBaleCcGroup(input, document);
            semantic.baleCc = importedBale.wrapper;
            semantic.baleCcSourceGroup = importedBale.sourceGroup;

            stage = "place template background";
            semantic.templateBackgroundLayer = placeFileAsSmartObject(document, childFile(folder, payload.templateBackground.fileName), groups.templateBackground, "GENERATED TEMPLATE BACKGROUND");
            applyLayerPlacement(document, semantic.templateBackgroundLayer, "templateBackground", null, payload.templateBackground.fitMode, payload.style.layoutPreset);

            stage = "create editable panels and finishing layers";
            createProceduralMatchLayers(document, groups, payload.style, semantic);

            stage = "place protected assets";
            var assetKeys = ownKeys(payload.assets);
            for (var assetIndex = 0; assetIndex < assetKeys.length; assetIndex++) {
                var assetRole = assetKeys[assetIndex], placement = payload.placements && own(payload.placements, assetRole) ? payload.placements[assetRole] : null;
                semantic[assetRole] = placeMatchAsset(document, folder, assetRole, payload.assets[assetRole], groups, placement, payload.style.accentColor, payload.style.layoutPreset, semantic, warnings, artDirection, placementDiagnostics);
                if (
                    payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET &&
                    (assetRole === "competitorLeft" || assetRole === "competitorRight")
                ) {
                    assertEccwCompetitorVisible(document, semantic[assetRole], groups, assetRole);
                }
            }

            stage = "create editable text";
            var fontList = installedFonts(), approvedEccwFont = null, textKeys = ownKeys(payload.text);
            if (payload.style.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
                approvedEccwFont = resolveApprovedEccwFont(fontList);
                recordApprovedEccwFont(payload.style, approvedEccwFont, warnings);
            }
            for (var textIndex = 0; textIndex < textKeys.length; textIndex++) {
                var textRole = textKeys[textIndex];
                var textGroup = textRole === "date" || textRole === "stipulation" || textRole === "time" || textRole === "venue" ? groups.eventInformation : (textRole === "championship" ? groups.championshipAndBelt : groups.matchTitleGroup);
                semantic[textRole] = createEditableMatchText(document, textGroup, textRole, payload.text[textRole], payload.style, fontList, warnings, approvedEccwFont, artDirection);
            }

            stage = "validate deterministic preview";
            validateEccwPreviewLayout(document, semantic, payload.style.layoutPreset, payload.assets, payload.text, groups, approvedEccwFont, artDirection, placementDiagnostics);
            var artDirectionRecord = artDirection ?
                buildEccwArtDirectionRecord(document, semantic, groups, requestedArtDirection, artDirection, approvedEccwFont, placementDiagnostics.showLogo, placementDiagnostics.vsFill) :
                null;

            stage = "save layered PSD";
            if (outputPsd.exists || outputPreview.exists || outputManifest.exists) throw new Error("An output appeared while the job was running; no output was overwritten.");
            attemptedOutputs.push(outputPsd);
            var psdOptions = new PhotoshopSaveOptions();
            psdOptions.layers = true; psdOptions.embedColorProfile = true; psdOptions.alphaChannels = true; psdOptions.annotations = true; psdOptions.spotColors = true;
            document.saveAs(outputPsd, psdOptions, false, Extension.LOWERCASE);

            stage = "export flattened PNG";
            if (outputPreview.exists) throw new Error("The PNG output appeared while the job was running; it was not overwritten.");
            attemptedOutputs.push(outputPreview);
            previewDocument = document.duplicate(payload.outputPreviewName.replace(/\.png$/i, "_preview"), true);
            app.activeDocument = previewDocument; previewDocument.flatten(); savePng(previewDocument, outputPreview);
            previewDocument.close(SaveOptions.DONOTSAVECHANGES); previewDocument = null; app.activeDocument = document;

            stage = "write match-card manifest";
            var semanticLayers = captureSemanticLayers(document, semantic);
            var manifest = buildCreateManifest(input, payload, semanticLayers, warnings, artDirectionRecord);
            validateMatchCardManifest(manifest);
            attemptedOutputs.push(outputManifest);
            writeMatchCardManifest(outputManifest, manifest);

            if (previousDialogs !== null) try { app.displayDialogs = previousDialogs; } catch (_createDialogRestoreSuccessError) {}
            return {
                outputPsdName: payload.outputPsdName,
                outputPreviewName: payload.outputPreviewName,
                outputManifestName: payload.outputManifestName,
                outputDocumentOpen: document.name,
                baleCcImported: true,
                protectedAssetsPlacedAsSmartObjects: true,
                originalAssetsPreserved: true,
                logoPlacement: placementDiagnostics.showLogo ? cloneJsonValue(placementDiagnostics.showLogo) : null,
                vsFill: artDirectionRecord ? cloneJsonValue(artDirectionRecord.vsFill) : null,
                warnings: warnings
            };
        } catch (error) {
            if (previewDocument) try { previewDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_createPreviewCloseError) {}
            if (document) try { document.close(SaveOptions.DONOTSAVECHANGES); } catch (_createDocumentCloseError) {}
            restoreActiveDocument(previous);
            var cleanupFailures = [];
            cleanupAttemptedOutputs(attemptedOutputs, cleanupFailures);
            if (previousDialogs !== null) try { app.displayDialogs = previousDialogs; } catch (_createDialogRestoreError) {}
            var suffix = cleanupFailures.length ? " Cleanup error: " + cleanupFailures.join("; ") + "." : "";
            throw new Error("createMatchCard stage \"" + stage + "\" failed: " + error.message + suffix);
        }
    }
    function readValidatedMatchCardManifest(file) {
        if (!file.exists) throw new Error("Match-card manifest not found: " + file.name);
        if (Number(file.length) > 2000000) throw new Error("Match-card manifest exceeds the 2 MB safety limit.");
        var text = readUtf8(file.fsName);
        return validateMatchCardManifest(parseJson(text));
    }
    function updateSolidFillSemantic(document, references, role, color) {
        if (!references[role]) throw new Error("Manifest is missing required editable color role: " + role);
        app.activeDocument = document; document.activeLayer = references[role];
        try { setActiveSolidFillColor(color); } catch (error) { throw new Error("Could not update editable fill " + role + ": " + error.message); }
    }
    function applyThemeChanges(document, references, styleChanges, themeColors, layoutPreset) {
        if (!styleChanges) return;
        if (layoutPreset !== ECCW_PANEL_LAYOUT_PRESET) {
            if (own(styleChanges, "primaryColor")) updateSolidFillSemantic(document, references, "titleBacking", themeColors.primaryColor);
            if (own(styleChanges, "secondaryColor")) {
                updateSolidFillSemantic(document, references, "fullFrameAtmosphere", themeColors.secondaryColor);
                updateSolidFillSemantic(document, references, "lowerThirdPanel", themeColors.secondaryColor);
                updateSolidFillSemantic(document, references, "showLogoPlate", themeColors.secondaryColor);
            }
            if (own(styleChanges, "accentColor")) {
                updateSolidFillSemantic(document, references, "lowerLightStrip", themeColors.accentColor);
                updateSolidFillSemantic(document, references, "finishingGlow", themeColors.accentColor);
            }
            if (own(styleChanges, "metallicColor")) {
                updateSolidFillSemantic(document, references, "topBorder", themeColors.metallicColor);
                updateSolidFillSemantic(document, references, "bottomBorder", themeColors.metallicColor);
            }
        }
        var textRoleIndex, textRole, textColor;
        if (own(styleChanges, "accentColor") && layoutPreset !== ECCW_PANEL_LAYOUT_PRESET) {
            textColor = new SolidColor(); textColor.rgb.red = themeColors.accentColor.red; textColor.rgb.green = themeColors.accentColor.green; textColor.rgb.blue = themeColors.accentColor.blue;
            for (textRoleIndex = 0; textRoleIndex < MATCH_TEXT_ROLES.length; textRoleIndex++) {
                textRole = MATCH_TEXT_ROLES[textRoleIndex];
                if (textRole === "championship" || !references[textRole]) continue;
                if (!isTextLayer(references[textRole])) throw new Error("Semantic text role is no longer editable: " + textRole);
                references[textRole].textItem.color = textColor;
            }
        }
        if (own(styleChanges, "metallicColor") && references.championship) {
            textColor = new SolidColor(); textColor.rgb.red = themeColors.metallicColor.red; textColor.rgb.green = themeColors.metallicColor.green; textColor.rgb.blue = themeColors.metallicColor.blue;
            if (!isTextLayer(references.championship)) throw new Error("Semantic championship role is no longer editable text.");
            references.championship.textItem.color = textColor;
        }
    }
    function applyRequestedFonts(document, references, styleFonts, requestedFonts, warnings) {
        if (!requestedFonts) return;
        var fonts = installedFonts();
        for (var textRoleIndex = 0; textRoleIndex < MATCH_TEXT_ROLES.length; textRoleIndex++) {
            var textRole = MATCH_TEXT_ROLES[textRoleIndex], fontRole = fontRoleForText(textRole);
            if (!own(requestedFonts, fontRole) || !references[textRole]) continue;
            var layer = references[textRole];
            if (!isTextLayer(layer)) throw new Error("Semantic role " + textRole + " is no longer editable text.");
            var font = resolveMatchFont(requestedFonts[fontRole], fontRole, fonts, warnings);
            if (font) {
                try { layer.textItem.font = font; } catch (error) { warnings.push("Photoshop could not apply font " + font + " to " + textRole + ": " + error.message); }
            }
        }
        mergeOwn(styleFonts, requestedFonts);
    }
    function refreshRecordedOuterGlows(document, references, placements, accentColor) {
        var roles = ownKeys(placements || {});
        for (var i = 0; i < roles.length; i++) {
            var role = roles[i];
            if (placements[role].outerGlow === true && references[role]) setLayerEffectsForPlacement(document, references[role], { outerGlow: true }, accentColor);
        }
    }
    function visibilityTarget(references, role) {
        return references[role] || null;
    }
    function applyExistingAssetPlacement(document, references, groups, role, placementChanges, previousPlacement, accentColor, layoutPreset, artDirection, logoSourceGeometry, placementDiagnostics) {
        var layer = references[role], effective = mergedPlacement(previousPlacement, placementChanges);
        var isEccwCoreAsset = layoutPreset === ECCW_PANEL_LAYOUT_PRESET && valueInList(role, ["competitorLeft", "competitorRight", "showLogo"]);
        if (isEccwCoreAsset) {
            var baseRole = role + "ClippingBase";
            if (references[baseRole] || Boolean(layer.grouped)) {
                throw new Error("The ECCW preset refuses a clipping base or LayerSet clipping relationship for " + role + ".");
            }
            if (role === "competitorLeft" || role === "competitorRight") {
                var priorMaskOwned = previousPlacement && previousPlacement.nonGenerativeMask === true;
                var hasExistingMask = layerHasUserMask(layer);
                if (hasExistingMask && !priorMaskOwned) throw new Error("The existing mask for " + role + " is not manifest-owned; refusing to replace it.");
                if (hasExistingMask) deleteActiveUserMask(document, layer);
                var unmaskedBounds = applyEccwVisibleContentPlacement(document, layer, role, artDirection);
                applyMandatoryEccwCutoffMask(document, layer, role, unmaskedBounds, Number(artDirection[role].cutoffY));
                setEccwCompetitorShadow(document, layer, artDirection[role]);
            } else {
                applyEccwVisibleContentPlacement(document, layer, role, artDirection, logoSourceGeometry, placementDiagnostics);
                setLayerEffectsForPlacement(document, layer, placementChanges, accentColor);
            }
            return;
        }
        var geometryFields = ["coordinateSpace", "x", "y", "fitMode", "scale", "maxWidth", "maxHeight"], geometryChanged = false;
        for (var geometryIndex = 0; geometryIndex < geometryFields.length; geometryIndex++) if (own(placementChanges, geometryFields[geometryIndex])) geometryChanged = true;
        var priorNonGenerativeMaskOwned = previousPlacement && previousPlacement.nonGenerativeMask === true;
        if (geometryChanged && priorNonGenerativeMaskOwned) {
            if (!layerHasUserMask(layer)) throw new Error("Manifest-owned non-generative mask is missing for " + role + ".");
            deleteActiveUserMask(document, layer);
        }
        if (geometryChanged) {
            var executionPlacement = cloneJsonValue(placementChanges), scaleChanged = own(placementChanges, "scale");
            var effectiveFit = own(effective, "fitMode") ? effective.fitMode : "contain";
            var changesTargetBounds = own(placementChanges, "coordinateSpace") || own(placementChanges, "fitMode") || own(placementChanges, "maxWidth") || own(placementChanges, "maxHeight");
            var scaleNeedsFitBaseline = scaleChanged && effectiveFit !== "keep-transform";
            if (!own(executionPlacement, "coordinateSpace") && own(effective, "coordinateSpace")) executionPlacement.coordinateSpace = effective.coordinateSpace;
            if (changesTargetBounds || scaleNeedsFitBaseline) {
                var targetFields = ["coordinateSpace", "x", "y", "maxWidth", "maxHeight"];
                for (var targetFieldIndex = 0; targetFieldIndex < targetFields.length; targetFieldIndex++) {
                    var targetField = targetFields[targetFieldIndex];
                    if (!own(executionPlacement, targetField) && own(effective, targetField)) executionPlacement[targetField] = cloneJsonValue(effective[targetField]);
                }
                if (!own(executionPlacement, "fitMode") && own(effective, "fitMode")) executionPlacement.fitMode = effective.fitMode;
                var resolvedFit = own(executionPlacement, "fitMode") ? executionPlacement.fitMode : (scaleNeedsFitBaseline ? effectiveFit : ((own(executionPlacement, "maxWidth") || own(executionPlacement, "maxHeight")) ? "contain" : "keep-transform"));
                if (!own(executionPlacement, "fitMode")) executionPlacement.fitMode = resolvedFit;
                if (!own(executionPlacement, "scale") && own(effective, "scale") && (resolvedFit === "contain" || resolvedFit === "cover")) executionPlacement.scale = effective.scale;
            }
            var executionFit = own(executionPlacement, "fitMode") ? executionPlacement.fitMode : "keep-transform";
            if (scaleChanged && executionFit === "keep-transform") {
                var priorScale = previousPlacement && own(previousPlacement, "scale") ? Number(previousPlacement.scale) : 1;
                executionPlacement.scale = Number(placementChanges.scale) / priorScale;
            }
            var defaultFit = changesTargetBounds || scaleNeedsFitBaseline ? effectiveFit : "keep-transform";
            applyLayerPlacement(document, layer, role, executionPlacement, defaultFit, layoutPreset);
        }
        var bounds = placementTargetBounds(document, role, effective, layoutPreset);
        var baseRole = role + "ClippingBase", priorClippingOwned = previousPlacement && previousPlacement.clippingMask === true;
        if (references[baseRole] && !priorClippingOwned) throw new Error("Manifest clipping-base ownership is inconsistent for " + role + ".");
        if (own(placementChanges, "clippingMask") || (geometryChanged && effective.clippingMask === true)) {
            var updatedBase = applyClippingPreference(document, layer, groupForAssetRole(groups, role), role, bounds, effective.clippingMask, priorClippingOwned ? references[baseRole] : null);
            if (updatedBase) references[baseRole] = updatedBase;
            else if (own(references, baseRole)) delete references[baseRole];
        }
        if (own(placementChanges, "nonGenerativeMask") || (geometryChanged && effective.nonGenerativeMask === true)) applyNonGenerativeMaskPreference(document, layer, bounds, effective.nonGenerativeMask, role, priorNonGenerativeMaskOwned, false);
        setLayerEffectsForPlacement(document, layer, placementChanges, accentColor);
    }
    function applyVisibilityChanges(references, changes) {
        if (!changes) return;
        for (var i = 0; i < changes.length; i++) {
            var target = visibilityTarget(references, changes[i].role);
            if (!target) throw new Error("Manifest has no semantic layer for visibility role: " + changes[i].role);
            target.visible = changes[i].visible;
            if (Boolean(target.visible) !== changes[i].visible) throw new Error("Photoshop did not retain visibility for role: " + changes[i].role);
        }
    }
    function sourceBaleState(document, baleCc) {
        var wrappers = [], matchingGroups = [];
        for (var i = 0; i < document.layers.length; i++) if (document.layers[i].typename === "LayerSet" && document.layers[i].name === "00 - BALE CC") wrappers.push(document.layers[i]);
        findNamedGroups(document.layers, baleCc.groupName, matchingGroups);
        if (wrappers.length > 1 || matchingGroups.length > 1) throw new Error("The source match card contains duplicate Bale CC groups.");
        if (matchingGroups.length === 1 && wrappers.length !== 1) throw new Error("The Bale CC source group is not contained by exactly one 00 - BALE CC wrapper.");
        if (matchingGroups.length === 1) {
            var wrapperEntry = semanticLayerEntry(document, wrappers[0]), sourceEntry = semanticLayerEntry(document, matchingGroups[0]);
            if (!indexPathIsPrefix(wrapperEntry.indexPath, sourceEntry.indexPath) || sourceEntry.indexPath.length !== wrapperEntry.indexPath.length + 1) throw new Error("The Bale CC source group is not a direct child of its semantic wrapper.");
        }
        return { wrapper: wrappers.length ? wrappers[0] : null, sourceGroup: matchingGroups.length ? matchingGroups[0] : null };
    }
    function validateSourceMatchCardIntegrity(document, manifest, sourceTargets) {
        if (toPixels(document.width) !== Number(manifest.canvas.width) || toPixels(document.height) !== Number(manifest.canvas.height) || Math.abs(Number(document.resolution) - Number(manifest.canvas.resolution)) > 0.001) {
            throw new Error("The source document canvas or resolution no longer matches the manifest.");
        }
        var requiredGroups = ["templateBackground", "atmosphere", "framesAndPanels", "competitorRenders", "championshipAndBelt", "matchTitleGroup", "eventInformation", "showLogoGroup", "finishingEffects"];
        if (manifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            requiredGroups = ["templateBackground", "competitorRenders", "matchTitleGroup", "eventInformation", "showLogoGroup"];
        }
        for (var groupIndex = 0; groupIndex < requiredGroups.length; groupIndex++) {
            var groupRole = requiredGroups[groupIndex];
            if (!sourceTargets[groupRole] || sourceTargets[groupRole].layer.typename !== "LayerSet") throw new Error("Required semantic group is missing or no longer a group: " + groupRole);
        }
        if (!sourceTargets.templateBackgroundLayer || !isSmartObject(sourceTargets.templateBackgroundLayer.layer)) throw new Error("The template background is no longer a Smart Object.");
        var assetRoles = ownKeys(manifest.assets);
        for (var assetIndex = 0; assetIndex < assetRoles.length; assetIndex++) {
            var assetRole = assetRoles[assetIndex];
            if (!sourceTargets[assetRole] || !isSmartObject(sourceTargets[assetRole].layer)) throw new Error("Protected asset is no longer a Smart Object: " + assetRole);
            var baseRole = assetRole + "ClippingBase", placement = own(manifest.placements, assetRole) ? manifest.placements[assetRole] : null;
            if (placement && placement.clippingMask === true) {
                if (!sourceTargets[baseRole] || !Boolean(sourceTargets[assetRole].layer.grouped)) throw new Error("Manifest-owned clipping structure is incomplete for " + assetRole);
                var assetPath = sourceTargets[assetRole].indexPath, basePath = sourceTargets[baseRole].indexPath;
                if (assetPath.length !== basePath.length) throw new Error("Manifest-owned clipping base is not an immediate sibling for " + assetRole);
                for (var pathIndex = 0; pathIndex < assetPath.length - 1; pathIndex++) if (Number(assetPath[pathIndex]) !== Number(basePath[pathIndex])) throw new Error("Manifest-owned clipping base has a different parent for " + assetRole);
                if (Number(basePath[basePath.length - 1]) !== Number(assetPath[assetPath.length - 1]) + 1) throw new Error("Manifest-owned clipping base is not immediately below " + assetRole);
            } else if (sourceTargets[baseRole]) throw new Error("A clipping-base semantic role exists without manifest ownership for " + assetRole);
            if (placement && placement.nonGenerativeMask === true && !layerHasUserMask(sourceTargets[assetRole].layer)) throw new Error("Manifest-owned non-generative mask is missing for " + assetRole);
        }
        var textRoles = ownKeys(manifest.text);
        for (var textIndex = 0; textIndex < textRoles.length; textIndex++) {
            var textRole = textRoles[textIndex];
            if (!sourceTargets[textRole] || !isTextLayer(sourceTargets[textRole].layer)) throw new Error("Manifest text role is no longer editable text: " + textRole);
        }
    }
    function buildUpdatedManifest(previousManifest, payload, semanticLayers, warnings) {
        var changes = payload.changes, manifest = cloneJsonValue(previousManifest);
        manifest.outputPsdName = payload.outputPsdName;
        manifest.outputPreviewName = payload.outputPreviewName;
        manifest.outputManifestName = payload.outputManifestName;
        manifest.parentManifestName = payload.manifestFileName;
        manifest.updatedAt = utcTimestamp();
        manifest.semanticLayers = semanticLayers;
        if (own(changes, "templateBackground")) manifest.templateBackground = cloneJsonValue(changes.templateBackground);
        if (own(changes, "assets")) mergeOwn(manifest.assets, changes.assets);
        if (own(changes, "text")) mergeOwn(manifest.text, changes.text);
        if (own(changes, "placements")) mergePlacementMap(manifest.placements, changes.placements);
        if (own(changes, "style")) {
            var styleKeys = ownKeys(changes.style);
            for (var i = 0; i < styleKeys.length; i++) {
                if (styleKeys[i] === "fonts") mergeOwn(manifest.styleFonts, changes.style.fonts);
                else manifest.themeColors[styleKeys[i]] = cloneJsonValue(changes.style[styleKeys[i]]);
            }
        }
        manifest.warnings = warnings.slice(0);
        return manifest;
    }
    function updateMatchCard(input) {
        var payload = validateUpdateMatchCardPayload(input.payload || {}), folder = matchWorkingFolder(input), baleCc = configuredBaleCc(input, true);
        var stage = "preflight", manifestFile = childFile(folder, payload.manifestFileName), previousManifest = readValidatedMatchCardManifest(manifestFile);
        if (previousManifest.outputManifestName.toLowerCase() !== payload.manifestFileName.toLowerCase()) throw new Error("The selected manifest filename does not match its recorded outputManifestName.");
        if (previousManifest.baleCc.packageFileName.toLowerCase() !== baleCc.packageFileName.toLowerCase() || previousManifest.baleCc.groupName !== baleCc.groupName) throw new Error("The manifest Bale CC identity does not match trusted local configuration.");
        if (payload.outputPsdName.toLowerCase() === previousManifest.outputPsdName.toLowerCase() || payload.outputPreviewName.toLowerCase() === previousManifest.outputPreviewName.toLowerCase()) throw new Error("Update outputs must use new versioned filenames.");
        if (previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            if (
                own(payload.changes, "templateBackground") &&
                String(payload.changes.templateBackground.fileName).toLowerCase() !== ECCW_PANEL_TEMPLATE_FILE_NAME.toLowerCase()
            ) {
                throw new Error("The ECCW panel preset cannot replace its dedicated template background with another file.");
            }
            if (own(payload.changes, "assets")) {
                var eccwUpdateAssetRoles = ownKeys(payload.changes.assets);
                for (var eccwUpdateAssetIndex = 0; eccwUpdateAssetIndex < eccwUpdateAssetRoles.length; eccwUpdateAssetIndex++) {
                    if (!valueInList(eccwUpdateAssetRoles[eccwUpdateAssetIndex], ["competitorLeft", "competitorRight", "showLogo"])) throw new Error("The ECCW panel preset update contains an unsupported asset role.");
                }
            }
            if (own(payload.changes, "text")) {
                var eccwUpdateTextRoles = ownKeys(payload.changes.text);
                for (var eccwUpdateTextIndex = 0; eccwUpdateTextIndex < eccwUpdateTextRoles.length; eccwUpdateTextIndex++) {
                    if (!valueInList(eccwUpdateTextRoles[eccwUpdateTextIndex], ["competitorLeftName", "competitorRightName", "matchTitle", "date"])) throw new Error("The ECCW panel preset update contains an unsupported text role.");
                }
                if (
                    own(payload.changes.text, "matchTitle") &&
                    String(payload.changes.text.matchTitle).replace(/^\s+|\s+$/g, "").toUpperCase() !== "VS"
                ) {
                    throw new Error('The ECCW panel preset matchTitle must remain "VS".');
                }
            }
        }
        if (own(payload.changes, "placements")) {
            var requestedPlacementRoles = ownKeys(payload.changes.placements);
            for (var placementIndex = 0; placementIndex < requestedPlacementRoles.length; placementIndex++) {
                var requestedPlacementRole = requestedPlacementRoles[placementIndex];
                var roleAlreadyExists = own(previousManifest.assets, requestedPlacementRole);
                var roleWillBeAdded = own(payload.changes, "assets") && own(payload.changes.assets, requestedPlacementRole);
                if (!roleAlreadyExists && !roleWillBeAdded) throw new Error("Placement update does not reference an existing or replacement asset: " + requestedPlacementRole);
                var priorPlacement = own(previousManifest.placements, requestedPlacementRole) ? previousManifest.placements[requestedPlacementRole] : null;
                validatePlacement(mergedPlacement(priorPlacement, payload.changes.placements[requestedPlacementRole]), "merged changes.placements." + requestedPlacementRole);
            }
        }
        var sourceFile = childFile(folder, previousManifest.outputPsdName);
        if (!sourceFile.exists) throw new Error("Prior match-card PSD not found: " + previousManifest.outputPsdName);
        var changedFiles = [], i;
        if (own(payload.changes, "templateBackground")) changedFiles.push(payload.changes.templateBackground.fileName);
        if (own(payload.changes, "assets")) {
            var changedAssetKeys = ownKeys(payload.changes.assets);
            for (i = 0; i < changedAssetKeys.length; i++) changedFiles.push(payload.changes.assets[changedAssetKeys[i]]);
        }
        for (i = 0; i < changedFiles.length; i++) if (!childFile(folder, changedFiles[i]).exists) throw new Error("Missing requested update asset: " + changedFiles[i]);
        var baleStatus = inspectBaleCcPackage(input);
        if (!baleStatus.available) throw new Error(baleStatus.issue || "Bale CC package is unavailable.");
        var outputPsd = childFile(folder, payload.outputPsdName), outputPreview = childFile(folder, payload.outputPreviewName), outputManifest = childFile(folder, payload.outputManifestName);
        if (outputPsd.exists || outputPreview.exists || outputManifest.exists) throw new Error("One or more update output files already exist; use new versioned names.");

        var previous = currentDocumentOrNull(), sourceDocument = null, sourceOwned = false, workingDocument = null, previewDocument = null, attemptedOutputs = [], warnings = [], placementDiagnostics = {};
        var approvedEccwFont = null;
        var updateRequestedArtDirection = previousManifest.artDirection ? cloneJsonValue(previousManifest.artDirection.requested) : {};
        var updateArtDirection = previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET ?
            (previousManifest.artDirection ? resolvedEccwArtDirection(previousManifest.artDirection.resolved) : resolvedEccwArtDirection({})) :
            null;
        if (previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
            if (!own(payload.changes, "placements")) payload.changes.placements = {};
            var normalizedEccwPlacementRoles = ["competitorLeft", "competitorRight", "showLogo"];
            for (var normalizedPlacementIndex = 0; normalizedPlacementIndex < normalizedEccwPlacementRoles.length; normalizedPlacementIndex++) {
                var normalizedPlacementRole = normalizedEccwPlacementRoles[normalizedPlacementIndex];
                var requestedEccwPlacement = own(payload.changes.placements, normalizedPlacementRole) ?
                    payload.changes.placements[normalizedPlacementRole] :
                    (own(previousManifest.placements, normalizedPlacementRole) ? previousManifest.placements[normalizedPlacementRole] : null);
                payload.changes.placements[normalizedPlacementRole] = deterministicEccwPlacement(
                    normalizedPlacementRole,
                    requestedEccwPlacement,
                    warnings,
                    updateArtDirection
                );
            }
        }
        var previousDialogs = null;
        try { previousDialogs = app.displayDialogs; app.displayDialogs = DialogModes.NO; } catch (_updateDialogReadError) {}
        try {
            stage = "open prior match card";
            sourceDocument = findOpenDocumentForFile(sourceFile);
            if (sourceDocument) {
                if (!sourceDocument.saved) throw new Error("The prior match-card PSD is open with unsaved changes; save or close it before updating.");
            } else { sourceDocument = app.open(sourceFile); sourceOwned = true; }
            app.activeDocument = sourceDocument;

            stage = "validate manifest semantic roles";
            var sourceTargets = {}, semanticKeys = ownKeys(previousManifest.semanticLayers), role;
            var manifestBaleWrapper = resolveOptionalLayerByManifestEntry(sourceDocument, "baleCc", previousManifest.semanticLayers.baleCc);
            var manifestBaleSourceGroup = resolveOptionalLayerByManifestEntry(sourceDocument, "baleCcSourceGroup", previousManifest.semanticLayers.baleCcSourceGroup);
            if (!manifestBaleWrapper && manifestBaleSourceGroup) throw new Error("The manifest-owned Bale CC source group exists without its wrapper.");
            if (manifestBaleWrapper && manifestBaleWrapper.indexPath.length !== 1) throw new Error("The manifest-owned Bale CC wrapper is no longer a top-level group.");
            if (manifestBaleWrapper && manifestBaleSourceGroup && (!indexPathIsPrefix(manifestBaleWrapper.indexPath, manifestBaleSourceGroup.indexPath) || manifestBaleSourceGroup.indexPath.length !== manifestBaleWrapper.indexPath.length + 1)) throw new Error("The manifest-owned Bale CC source group is not a direct child of its wrapper.");
            if (manifestBaleWrapper) sourceTargets.baleCc = manifestBaleWrapper;
            if (manifestBaleSourceGroup) sourceTargets.baleCcSourceGroup = manifestBaleSourceGroup;
            for (i = 0; i < semanticKeys.length; i++) {
                role = semanticKeys[i];
                if (role === "baleCc" || role === "baleCcSourceGroup") continue;
                sourceTargets[role] = resolveLayerByManifestEntry(sourceDocument, role, previousManifest.semanticLayers[role]);
            }
            validateSourceMatchCardIntegrity(sourceDocument, previousManifest, sourceTargets);
            var baleState = sourceBaleState(sourceDocument, baleCc);
            if (baleState.wrapper && (!manifestBaleWrapper || safeLayerId(baleState.wrapper) !== safeLayerId(manifestBaleWrapper.layer))) throw new Error("A Bale CC wrapper exists but is not the manifest-owned wrapper.");
            if (baleState.sourceGroup && (!manifestBaleSourceGroup || safeLayerId(baleState.sourceGroup) !== safeLayerId(manifestBaleSourceGroup.layer))) throw new Error("A Bale CC source group exists but is not the manifest-owned source group.");

            stage = "duplicate prior match card";
            workingDocument = sourceDocument.duplicate(payload.outputPsdName.replace(/\.psd$/i, ""), false);
            app.activeDocument = workingDocument;
            var references = {};
            for (role in sourceTargets) if (own(sourceTargets, role)) {
                references[role] = getLayerByIndexPath(workingDocument, sourceTargets[role].indexPath);
                if (own(previousManifest.semanticLayers, role)) verifyDuplicatedSemanticLayer(references[role], role, previousManifest.semanticLayers[role]);
            }

            stage = "ensure Bale CC";
            if (!references.baleCcSourceGroup) {
                if (references.baleCc) references.baleCcSourceGroup = importBaleCcSourceIntoWrapper(input, workingDocument, references.baleCc);
                else {
                    var importedBale = importBaleCcGroup(input, workingDocument);
                    references.baleCc = importedBale.wrapper; references.baleCcSourceGroup = importedBale.sourceGroup;
                }
            }
            var updatedBaleState = sourceBaleState(workingDocument, baleCc);
            if (!updatedBaleState.wrapper || !updatedBaleState.sourceGroup) throw new Error("The updated card does not contain exactly one complete Bale CC group.");
            references.baleCc = updatedBaleState.wrapper; references.baleCcSourceGroup = updatedBaleState.sourceGroup;

            var groups = {
                templateBackground: references.templateBackground,
                atmosphere: references.atmosphere,
                framesAndPanels: references.framesAndPanels,
                competitorRenders: references.competitorRenders,
                championshipAndBelt: references.championshipAndBelt,
                matchTitleGroup: references.matchTitleGroup,
                eventInformation: references.eventInformation,
                showLogoGroup: references.showLogoGroup,
                finishingEffects: references.finishingEffects
            };
            var requiredGroupRoles = previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET ?
                ["templateBackground", "competitorRenders", "matchTitleGroup", "eventInformation", "showLogoGroup"] :
                ["templateBackground", "atmosphere", "framesAndPanels", "competitorRenders", "championshipAndBelt", "matchTitleGroup", "eventInformation", "showLogoGroup", "finishingEffects"];
            for (var requiredGroupIndex = 0; requiredGroupIndex < requiredGroupRoles.length; requiredGroupIndex++) {
                var requiredGroupRole = requiredGroupRoles[requiredGroupIndex];
                if (!groups[requiredGroupRole] || groups[requiredGroupRole].typename !== "LayerSet") throw new Error("Manifest semantic group is unavailable: " + requiredGroupRole);
            }
            if (previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) ensureEccwGroupOrder(workingDocument, groups);
            var currentStyle = {
                primaryColor: cloneJsonValue(previousManifest.themeColors.primaryColor),
                secondaryColor: cloneJsonValue(previousManifest.themeColors.secondaryColor),
                accentColor: cloneJsonValue(previousManifest.themeColors.accentColor),
                metallicColor: cloneJsonValue(previousManifest.themeColors.metallicColor),
                fonts: cloneJsonValue(previousManifest.styleFonts || {}),
                layoutPreset: previousManifest.layoutPreset
            };
            if (own(payload.changes, "style")) {
                var changedStyleKeys = ownKeys(payload.changes.style);
                for (i = 0; i < changedStyleKeys.length; i++) {
                    if (changedStyleKeys[i] === "fonts") mergeOwn(currentStyle.fonts, payload.changes.style.fonts);
                    else currentStyle[changedStyleKeys[i]] = cloneJsonValue(payload.changes.style[changedStyleKeys[i]]);
                }
            }
            if (previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
                approvedEccwFont = resolveApprovedEccwFont(installedFonts());
                recordApprovedEccwFont(currentStyle, approvedEccwFont, warnings);
                if (!own(payload.changes, "style")) payload.changes.style = {};
                payload.changes.style.fonts = cloneJsonValue(currentStyle.fonts);
            }

            if (own(payload.changes, "templateBackground")) {
                stage = "replace template background";
                if (!references.templateBackgroundLayer || !isSmartObject(references.templateBackgroundLayer)) throw new Error("Template-background semantic role is not a Smart Object.");
                workingDocument.activeLayer = references.templateBackgroundLayer;
                replaceSelectedSmartObject(childFile(folder, payload.changes.templateBackground.fileName));
                applyLayerPlacement(workingDocument, references.templateBackgroundLayer, "templateBackground", null, payload.changes.templateBackground.fitMode, previousManifest.layoutPreset);
            }

            if (own(payload.changes, "assets")) {
                stage = "replace protected assets";
                for (i = 0; i < changedAssetKeys.length; i++) {
                    var assetRole = changedAssetKeys[i], assetFile = childFile(folder, payload.changes.assets[assetRole]);
                    var placement = own(payload.changes, "placements") && own(payload.changes.placements, assetRole) ? payload.changes.placements[assetRole] : null;
                    if (
                        previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET &&
                        (assetRole === "competitorLeft" || assetRole === "competitorRight" || assetRole === "showLogo")
                    ) {
                        placement = deterministicEccwPlacement(assetRole, placement, warnings, updateArtDirection);
                    }
                    if (references[assetRole]) {
                        if (!isSmartObject(references[assetRole])) throw new Error("Semantic asset role is not a Smart Object: " + assetRole);
                        inspectCompetitorTransparencyBeforePlacement(assetFile, assetRole, warnings);
                        var replacementLogoSourceGeometry = previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && assetRole === "showLogo" ?
                            inspectEccwLogoSourceAlphaGeometry(assetFile) :
                            null;
                        workingDocument.activeLayer = references[assetRole];
                        replaceSelectedSmartObject(assetFile);
                        if (placement) {
                            var previousAssetPlacement = own(previousManifest.placements, assetRole) ? previousManifest.placements[assetRole] : null;
                            applyExistingAssetPlacement(workingDocument, references, groups, assetRole, placement, previousAssetPlacement, currentStyle.accentColor, previousManifest.layoutPreset, updateArtDirection, replacementLogoSourceGeometry, placementDiagnostics);
                        }
                    } else {
                        references[assetRole] = placeMatchAsset(workingDocument, folder, assetRole, payload.changes.assets[assetRole], groups, placement, currentStyle.accentColor, previousManifest.layoutPreset, references, warnings, updateArtDirection, placementDiagnostics);
                    }
                }
            }

            if (own(payload.changes, "placements")) {
                stage = "apply asset placements";
                var placementRoles = ownKeys(payload.changes.placements);
                for (i = 0; i < placementRoles.length; i++) {
                    role = placementRoles[i];
                    if (own(payload.changes, "assets") && own(payload.changes.assets, role)) continue;
                    if (!references[role] || !isSmartObject(references[role])) throw new Error("Placement role is not an existing Smart Object: " + role);
                    var previousPlacement = own(previousManifest.placements, role) ? previousManifest.placements[role] : null;
                    var existingLogoSourceGeometry = previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET && role === "showLogo" ?
                        inspectEccwLogoSourceAlphaGeometry(childFile(folder, previousManifest.assets.showLogo)) :
                        null;
                    applyExistingAssetPlacement(workingDocument, references, groups, role, payload.changes.placements[role], previousPlacement, currentStyle.accentColor, previousManifest.layoutPreset, updateArtDirection, existingLogoSourceGeometry, placementDiagnostics);
                }
            }

            if (own(payload.changes, "text")) {
                stage = "update editable text";
                var changedTextKeys = ownKeys(payload.changes.text), availableFonts = installedFonts();
                for (i = 0; i < changedTextKeys.length; i++) {
                    role = changedTextKeys[i];
                    if (references[role]) {
                        if (!isTextLayer(references[role])) throw new Error("Semantic text role is not editable text: " + role);
                        applyContentOnlyTextEdit(references[role], payload.changes.text[role]);
                        if (previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
                            constrainLiveTextToGeometry(
                                workingDocument,
                                references[role],
                                role,
                                textPositionAndSize(role, ECCW_PANEL_CANVAS_WIDTH, ECCW_PANEL_CANVAS_HEIGHT, ECCW_PANEL_LAYOUT_PRESET, updateArtDirection)
                            );
                        }
                    } else {
                        var targetTextGroup = role === "date" || role === "stipulation" || role === "time" || role === "venue" ? groups.eventInformation : (role === "championship" ? groups.championshipAndBelt : groups.matchTitleGroup);
                        references[role] = createEditableMatchText(workingDocument, targetTextGroup, role, payload.changes.text[role], currentStyle, availableFonts, warnings, approvedEccwFont, updateArtDirection);
                    }
                }
            }

            stage = "update editable theme and fonts";
            if (own(payload.changes, "style")) {
                applyThemeChanges(workingDocument, references, payload.changes.style, currentStyle, previousManifest.layoutPreset);
                if (own(payload.changes.style, "accentColor")) {
                    var effectivePlacements = cloneJsonValue(previousManifest.placements || {});
                    if (own(payload.changes, "placements")) mergePlacementMap(effectivePlacements, payload.changes.placements);
                    refreshRecordedOuterGlows(workingDocument, references, effectivePlacements, currentStyle.accentColor);
                }
                if (own(payload.changes.style, "fonts")) applyRequestedFonts(workingDocument, references, currentStyle.fonts, payload.changes.style.fonts, warnings);
            }
            if (previousManifest.layoutPreset === ECCW_PANEL_LAYOUT_PRESET) {
                applyApprovedEccwTextStyles(workingDocument, references, approvedEccwFont, updateArtDirection);
            }
            stage = "update visibility";
            if (own(payload.changes, "visibility")) applyVisibilityChanges(references, payload.changes.visibility);

            stage = "validate deterministic preview";
            var effectivePreviewAssets = cloneJsonValue(previousManifest.assets), effectivePreviewText = cloneJsonValue(previousManifest.text);
            if (own(payload.changes, "assets")) mergeOwn(effectivePreviewAssets, payload.changes.assets);
            if (own(payload.changes, "text")) mergeOwn(effectivePreviewText, payload.changes.text);
            validateEccwPreviewLayout(workingDocument, references, previousManifest.layoutPreset, effectivePreviewAssets, effectivePreviewText, groups, approvedEccwFont, updateArtDirection, placementDiagnostics);

            stage = "save versioned layered PSD";
            if (outputPsd.exists || outputPreview.exists || outputManifest.exists) throw new Error("An update output appeared while the job was running; no output was overwritten.");
            attemptedOutputs.push(outputPsd);
            var psdOptions = new PhotoshopSaveOptions();
            psdOptions.layers = true; psdOptions.embedColorProfile = true; psdOptions.alphaChannels = true; psdOptions.annotations = true; psdOptions.spotColors = true;
            workingDocument.saveAs(outputPsd, psdOptions, false, Extension.LOWERCASE);

            stage = "export versioned PNG";
            if (outputPreview.exists) throw new Error("The PNG output appeared while the update was running; it was not overwritten.");
            attemptedOutputs.push(outputPreview);
            previewDocument = workingDocument.duplicate(payload.outputPreviewName.replace(/\.png$/i, "_preview"), true);
            app.activeDocument = previewDocument; previewDocument.flatten(); savePng(previewDocument, outputPreview);
            previewDocument.close(SaveOptions.DONOTSAVECHANGES); previewDocument = null; app.activeDocument = workingDocument;

            stage = "write versioned manifest";
            var semanticLayers = captureSemanticLayers(workingDocument, references);
            var updatedManifest = buildUpdatedManifest(previousManifest, payload, semanticLayers, warnings);
            if (updateArtDirection) {
                updatedManifest.artDirection = buildEccwArtDirectionRecord(
                    workingDocument,
                    references,
                    groups,
                    updateRequestedArtDirection,
                    updateArtDirection,
                    approvedEccwFont,
                    placementDiagnostics.showLogo || (
                        previousManifest.artDirection && previousManifest.artDirection.logoPlacement ?
                            previousManifest.artDirection.logoPlacement :
                            null
                    ),
                    placementDiagnostics.vsFill
                );
            }
            validateMatchCardManifest(updatedManifest);
            attemptedOutputs.push(outputManifest); writeMatchCardManifest(outputManifest, updatedManifest);
            if (sourceOwned && sourceDocument) { sourceDocument.close(SaveOptions.DONOTSAVECHANGES); sourceDocument = null; }
            app.activeDocument = workingDocument;
            if (previousDialogs !== null) try { app.displayDialogs = previousDialogs; } catch (_updateDialogRestoreSuccessError) {}
            return {
                outputPsdName: payload.outputPsdName,
                outputPreviewName: payload.outputPreviewName,
                outputManifestName: payload.outputManifestName,
                outputDocumentOpen: workingDocument.name,
                baleCcPreservedOrImported: true,
                previousVersionPreserved: true,
                protectedAssetsPlacedAsSmartObjects: true,
                logoPlacement: placementDiagnostics.showLogo ? cloneJsonValue(placementDiagnostics.showLogo) : null,
                vsFill: updatedManifest.artDirection && updatedManifest.artDirection.vsFill ?
                    cloneJsonValue(updatedManifest.artDirection.vsFill) :
                    null,
                warnings: warnings
            };
        } catch (error) {
            if (previewDocument) try { previewDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_updatePreviewCloseError) {}
            if (workingDocument) try { workingDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_updateWorkingCloseError) {}
            if (sourceOwned && sourceDocument) try { sourceDocument.close(SaveOptions.DONOTSAVECHANGES); } catch (_updateSourceCloseError) {}
            restoreActiveDocument(previous);
            var cleanupFailures = [];
            cleanupAttemptedOutputs(attemptedOutputs, cleanupFailures);
            if (previousDialogs !== null) try { app.displayDialogs = previousDialogs; } catch (_updateDialogRestoreError) {}
            var suffix = cleanupFailures.length ? " Cleanup error: " + cleanupFailures.join("; ") + "." : "";
            throw new Error("updateMatchCard stage \"" + stage + "\" failed: " + error.message + suffix);
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
    if (input.type === "exportDocumentPreview") {
        return exportDocumentPreview(input);
    }
    if (input.type === "exportLayerPreviews") {
        return exportLayerPreviews(input);
    }
    if (input.type === "renameLayers") {
        return renameLayers(input);
    }
    if (input.type === "listMatchCardAssets") {
        return listMatchCardAssets(input);
    }
    if (input.type === "planMatchCard") {
        return planMatchCard(input);
    }
    if (input.type === "createMatchCard") {
        return createMatchCard(input);
    }
    if (input.type === "updateMatchCard") {
        return updateMatchCard(input);
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
