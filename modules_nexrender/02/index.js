const { render } = require('@nexrender/core')
const job  = require('./boomtown_module-02_camping_v003.json')

const main = async () => {
    const text = [
        'LIFE ON THE ROAD',
        'HOME IS WHERE YOU PARK',
        'THE VANLIFE COMMUNTY',
        'VANLIFE ADVENTURES',
        'VANLIFE ESSENTIALS',
        'EXPLORE MORE WORRY LESS'
    ];
    const count = 5; //20;

    for (let i = 0; i < count; i++) {
        job.assets[0].value = text[i % text.length];
        job.actions.postrender[1].output = `C:/git/nexrendertest/results/output_${`${i}`.padStart(2, '0')}.mp4`;
        const result = await render(job);
    }
}

main().catch(console.error);