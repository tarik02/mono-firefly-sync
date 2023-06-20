import * as fs from 'node:fs/promises';
import got, { HTTPError } from 'got';
import createFastify from 'fastify';
import _ from 'lodash';
import currencyCodes from 'currency-codes';

const fastify = createFastify({ logger: true });

const config = JSON.parse(
    await fs.readFile('./config.json', 'utf-8')
);

await fs.mkdir('./data', { recursive: true });

const getClientData = async () => {
    try {
        const stat = await fs.stat('./data/client-data.json');
        if (Date.now() - stat.mtime.getTime() < 1000 * 60 * 5) {
            return JSON.parse(await fs.readFile('./data/client-data.json', 'utf-8'));
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw e;
        }
    }

    const data = await got('https://api.monobank.ua/personal/client-info', {
        headers: {
            'X-Token': config.monobank.token
        }
    }).json();

    await fs.writeFile('./data/client-data.json', JSON.stringify(data));
    return data;
};

const getFireflyAccounts = async () => {
    const { data: accounts } = await got(`${ config.firefly.apiUrl }/v1/accounts`, {
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${ config.firefly.token }`
        }
    }).json();

    return accounts;
}

fastify.get('*', async (request, reply) => {
    return '';
});

fastify.post('*', async (request, reply) => {
    if (request.body.type !== 'StatementItem') {
        fastify.log.error({
            body: request.body
        }, 'Unknown request');
        throw new Error('Unknown request');
    }

    const { data: { account: monoAccountId, statementItem } } = request.body;

    fastify.log.info({
        account: monoAccountId,
        statementItem
    });

    const clientData = await getClientData();
    const fireflyAccounts = await getFireflyAccounts();

    const monobankAccount = clientData.accounts.find(account => account.id === monoAccountId);
    const fireflyAccount = fireflyAccounts.find(account => account.attributes.iban === monobankAccount.iban);

    const transaction = {
        type: statementItem.amount > 0 ? 'deposit' : 'withdrawal',
        date: new Date(statementItem.time * 1000).toISOString(),
        currency_code: currencyCodes.number(statementItem.currencyCode).code,
        amount: String(Math.abs(statementItem.amount) / 100),
        description: statementItem.description,
        notes: statementItem.comment,
        [ statementItem.amount > 0 ? 'destination_id' : 'source_id' ]: fireflyAccount.id,
        original_source: 'mono import'
    };

    fastify.log.info({
        transaction
    });

    try {
        await got.post(`${ config.firefly.apiUrl }/v1/transactions`, {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${ config.firefly.token }`
            },
            json: {
                group_title: null,
                error_if_duplicate_hash: false,
                transactions: [
                    transaction
                ]
            }
        }).json();
    } catch (e) {
        if (e instanceof HTTPError) {
            fastify.log.error(e.response.body);
        }
        throw e;
    }
});

try {
    await fastify.listen({
        host: '0.0.0.0',
        port: process.env.PORT ?? 3000
    });
} catch (e) {
    fastify.log.error(e);
    process.exit(1);
}

