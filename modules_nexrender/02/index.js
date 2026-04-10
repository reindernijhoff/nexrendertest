const { render } = require('@nexrender/core')
const job  = require('./boomtown_module-01_seasoned-citizen_v004.json')

const main = async () => {
    const veteran_1 = ['SEASONED CITIZEN', 'WISE ELDER', 'VETERAN HERO', 'EXPERIENCED WARRIOR', 'AGED CHAMPION'];
    const veteran_2 = ['ENDORSED EDNA VON'];
    const veteran_3 = ['VANDERHAUS'];
    const count = 5; //20;

    for (let i = 0; i < count; i++) {
        job.assets[0].value = veteran_1[i % veteran_1.length];
        job.assets[1].value = veteran_2[i % veteran_2.length];
        job.assets[2].value = veteran_3[i % veteran_3.length];
        job.actions.postrender[1].output = `C:/git/nexrendertest/results/output_${`${i}`.padStart(2, '0')}.mp4`;
        const result = await render(job);
    }
}

main().catch(console.error);