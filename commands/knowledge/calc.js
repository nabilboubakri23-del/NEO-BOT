import { evaluate, formatNumber } from '../../systems/knowledge/calculator.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';

/** .calc <expression> — safe calculator (no eval), Arabic digits, functions, factorial. */
export default {
    name: 'calc',
    aliases: ['calculate', 'calculator', 'حساب'],
    category: 'knowledge',
    description: 'Calculator: + - × ÷ ^ % ! sqrt sin cos log pi …',
    usage: '<expression>',
    examples: ['(15+5)*3', 'sqrt(144) + 2^8', '15% * 400', 'sin(30)'],
    permission: 'public',
    cooldown: 2,
    minArgs: 1,

    async execute(sock, message, args, ctx) {
        const expr = (ctx?.argsText || args.join(' ')).trim();
        let result;
        try {
            result = evaluate(expr);
        } catch (error) {
            throw new UserError(`Cannot calculate: ${error.message}`);
        }
        await message.reply(box('CALCULATOR', [`🧮 ${expr}`, '', `= ${formatNumber(result)}`]));
    }
};
