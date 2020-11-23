import SEDABus from './ra-seda-bus';
// const bus = require('./ra-seda-bus');

test('adds 1 + 2 to equal 3', () => {
    const bus = new SEDABus();
    expect(bus.sum(1, 2)).toBe(3);
});