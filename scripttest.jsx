// 1. Function to generate the random UID
function generateUID() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var uid = '';
    for (var i = 0; i < 16; i++) {
        uid += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return uid;
}

// 2. The main function that accepts your string argument
function updateTextLayer(customString) {
    var comp = null;

    // SAFE FETCH: Loop through the project to find the first composition
    // (since app.project.activeItem doesn't work in Nexrender/aerender)
    for (var j = 1; j <= app.project.numItems; j++) {
        if (app.project.item(j) instanceof CompItem) {
            comp = app.project.item(j);
            break;
        }
    }

    if (comp != null) {
        var targetLayer = null;

        // Find your text layer
        for (var i = 1; i <= comp.numLayers; i++) {
            var currentLayer = comp.layer(i);
            if (currentLayer.name === "text" || currentLayer.name === "[text]") {
                targetLayer = currentLayer;
                break;
            }
        }

        if (targetLayer != null && targetLayer instanceof TextLayer) {
            var newUID = generateUID();

            // Combine UID and the argument. '\r' creates a new line in AE text layers!
            var newText = newUID + "\r" + customString;

            targetLayer.property("Source Text").setValue(newText);
        }
    }
}

var name = 'testname';

if (typeof NX !== 'undefined') {
    name = NX.get('name');
}

updateTextLayer(name);