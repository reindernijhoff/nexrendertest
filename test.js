const { render } = require('@nexrender/core')
const job  = require('./boomtownjob.json')

function uppercaseFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function randomCaseEachLetter(str) {
    return str.split('').map(c => Math.random() > 0.5 ? c.toUpperCase() : c.toLowerCase()).join('');
}

const main = async () => {
    const names = ['freek', 'mart', 'een erg lange naam', 'reinder', 'vincent'];
    const greetings = ['hi', 'hello', 'welcome', 'greetings', 'hey'];
    const count = 5; //20;

    for (let i = 0; i < count; i++) {
        const name = names[i % names.length];
        const greeting = greetings[i % greetings.length];
        const color = [Math.random(), Math.random(), Math.random()];
        const max = Math.max(...color);
        const normalizedColor = color.map(c => c / max);

       job.assets[0].value = `${randomCaseEachLetter(name)}`;
        // job.assets[0].src = `file:///git/nexrendertest/${name}.jpg`;
        // job.assets[1].parameters[0].value = `${greeting} ${uppercaseFirst(name)}!`;
        // job.assets[2].value = normalizedColor;
        job.actions.postrender[1].output = `C:/git/nexrendertest/results/output_${`${i}`.padStart(2, '0')}.mp4`;
        const result = await render(job);
    }
}

// {
//     "type": "data",
//     "layerName": "copy name",
//     "property": "Source Text",
//     "value": "TEST"
// }

main().catch(console.error);