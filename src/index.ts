import * as fs from 'node:fs/promises';
import got, { HTTPError, PaginationOptions } from 'got';
import createFastify from 'fastify';
import _ from 'lodash';
import currencyCodes from 'currency-codes';
import z from 'zod';
import itAll from 'it-all';
import { startOfDay, endOfDay, getUnixTime } from 'date-fns';
import { pino } from 'pino';
import * as pinoPretty from 'pino-pretty';

const fastify = createFastify({
    logger: pino(pinoPretty.default.default()),
});

const config = z.object({
    server: z.object({
        host: z.string().default('0.0.0.0'),
        port: z.number().positive().default(80),
    }),
    monobank: z.object({
        token: z.string(),
        webhookUrl: z.string().nullable().default(null),
    }),
    firefly: z.object({
        apiUrl: z.string(),
        token: z.string(),
    }),
}).parse(
    JSON.parse(
        process.env.MONO_FIREFLY_SYNC_CONFIG ?? await fs.readFile('./config.json', 'utf-8')
    )
);

await fs.mkdir('./data', { recursive: true });

const TRANSACTION_TAG = 'monosync';

const fireflyClient = got.extend({
    prefixUrl: config.firefly.apiUrl,
    responseType: 'json',
    headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${ config.firefly.token }`,
    },
});

const monobankClient = got.extend({
    prefixUrl: 'https://api.monobank.ua',
    responseType: 'json',
    headers: {
        Accept: 'application/json',
        'X-Token': config.monobank.token,
    },
    retry: {
        calculateDelay: () => 60 * 1000
    },
})

const clientDataSchema = z.object({
    clientId: z.string(),
    name: z.string(),
    webHookUrl: z.string().transform(arg => arg === '' ? null : new URL(arg)),
    permissions: z.string(),
    accounts: z.array(z.object({
        id: z.string(),
        currencyCode: z.number(),
        balance: z.number(),
        iban: z.string(),
    })),
});

const statementItemSchema = z.object({
    id: z.string(),
    time: z.number().transform(time => new Date(time * 1000)),
    description: z.string(),
    amount: z.number(),
    balance: z.number(),
    comment: z.string().optional(),
    currencyCode: z.number(),
});

const fireflyAccountSchema = z.object({
    type: z.literal('accounts'),
    id: z.coerce.number(),
    attributes: z.object({
        iban: z.string().nullable(),
        current_balance: z.coerce.number(),
    }),
});

const fireflyTransactionItemSchema = z.object({
    user: z.coerce.number(),
    transaction_journal_id: z.coerce.number(),
    date: z.coerce.date(),
    tags: z.array(z.string()),
    description: z.string(),
    source_id: z.coerce.number().nullable(),
    source_name: z.string().nullable(),
    source_iban: z.string().nullable(),
    destination_id: z.coerce.number().nullable(),
    destination_name: z.string().nullable(),
    destination_iban: z.string().nullable(),
    amount: z.coerce.number(),
    type: z.string(),
    external_id: z.string().nullable(),
    external_url: z.string().nullable(),
});

const fireflyTransactionSchema = z.object({
    type: z.literal('transactions'),
    id: z.coerce.number(),
    attributes: z.object({
        created_at: z.coerce.date(),
        updated_at: z.coerce.date(),
        user: z.coerce.number(),
        group_title: z.string().nullable(),
        transactions: z.array(fireflyTransactionItemSchema),
    })
});

const CLIENT_DATA_CACHE_LIFETIME = 1000 * 60 * 5;

const getMonobankClientData = async (force = false) => {
    if (!force) {
        try {
            const stat = await fs.stat('./data/client-data.json');
            if (Date.now() - stat.mtime.getTime() < CLIENT_DATA_CACHE_LIFETIME) {
                return clientDataSchema.parse(
                    JSON.parse(await fs.readFile('./data/client-data.json', 'utf-8')),
                );
            }
        } catch (e: any) {
            if (e.code !== 'ENOENT') {
                throw e;
            }
        }
    }

    const data = await monobankClient.get('personal/client-info').json();

    await fs.writeFile('./data/client-data.json', JSON.stringify(data));
    return clientDataSchema.parse(data);
};

const getMonobankStatements = async (accountId: string, from: number, to?: number) => {
    const response = await monobankClient.get(
        `personal/statement/${ accountId }/${ from }${ to !== undefined ? `/${ to }` : '' }`
    );

    return z.array(statementItemSchema).parse(response.body);
};

const createFireflyPagination = <T>(itemSchema: z.Schema<T>): PaginationOptions<T, unknown> => ({
    transform: (response) => {
        return z.object({
            data: z.array(itemSchema),
        }).parse(response.body).data;
    },
    paginate: ({ response }) => {
        const parseResult = z.object({
            links: z.object({
                next: z.string(),
            }),
        }).safeParse(response.body);

        if (parseResult.success) {
            return {
                url: new URL(parseResult.data.links.next),
            };
        }

        return false;
    },
});

const getFireflyAccounts = () => fireflyClient.paginate(
    `v1/accounts`,
    {
        pagination: createFireflyPagination(fireflyAccountSchema),
    }
);

const getFireflyTransactions = () => fireflyClient.paginate(
    `v1/transactions`,
    {
        pagination: createFireflyPagination(fireflyTransactionSchema),
    }
);

const clientData = await getMonobankClientData();
const fireflyAccounts = await itAll(getFireflyAccounts());

const monobankToFireflyTransaction = async (accountId: string, statementItem: z.TypeOf<typeof statementItemSchema>) => {
    const clientData = await getMonobankClientData();

    const monobankAccount = clientData.accounts.find(account => account.id === accountId);
    if (monobankAccount === undefined) {
        return null;
    }

    const fireflyAccount = fireflyAccounts.find(account => account.attributes.iban === monobankAccount.iban);
    if (fireflyAccount === undefined) {
        return null;
    }

    return {
        type: statementItem.amount > 0 ? 'deposit' : 'withdrawal',
        date: statementItem.time.toISOString(),
        currency_code: currencyCodes.number(`${statementItem.currencyCode}`)!.code,
        amount: String(Math.abs(statementItem.amount) / 100),
        description: statementItem.description,
        notes: statementItem.comment,
        [ statementItem.amount > 0 ? 'destination_id' : 'source_id' ]: fireflyAccount.id,
        external_id: statementItem.id,
        external_url: 'https://api.monobank.ua',
        tags: [TRANSACTION_TAG],
    };
};

const createFireflyTransaction = async (transaction: any) => {
    try {
        await fireflyClient.post(`v1/transactions`, {
            json: {
                group_title: null,
                error_if_duplicate_hash: false,
                transactions: [
                    transaction,
                ],
            },
        }).json();
    } catch (e) {
        if (e instanceof HTTPError) {
            fastify.log.error(e.response.body);
        }
        throw e;
    }
};

async function recover() {
    for await (const transaction of getFireflyTransactions()) {
        const firstJournal = transaction.attributes.transactions[0];
        if (!(firstJournal.tags.includes(TRANSACTION_TAG) || firstJournal.external_url === 'https://api.monobank.ua')) {
            continue;
        }

        const eligableAccounts = clientData.accounts.filter(
            account => account.iban === firstJournal.source_iban || account.iban === firstJournal.destination_iban
        );
        if (!eligableAccounts.length) {
            continue;
        }

        for (const account of eligableAccounts) {
            const statements = await getMonobankStatements(
                account.id,
                getUnixTime(startOfDay(firstJournal.date)),
                getUnixTime(endOfDay(firstJournal.date)),
            );

            const fireflyAcccount = firstJournal.type === 'withdrawal'
                ? fireflyAccounts.find(it => it.id === firstJournal.source_id)!
                : fireflyAccounts.find(it => it.id === firstJournal.destination_id)!;

            const startingStatement = statements.find(
                statement => (
                    Math.round(statement.balance) === Math.round(fireflyAcccount.attributes.current_balance * 100) &&
                    (
                        (firstJournal.type === 'withdrawal' && Math.round(statement.amount) === Math.round(-firstJournal.amount * 100) && account.iban === firstJournal.source_iban) ||
                        (firstJournal.type === 'deposit' && Math.round(statement.amount) === Math.round(firstJournal.amount * 100) && account.iban === firstJournal.destination_iban)
                    )
                )
            );

            if (startingStatement === undefined) {
                continue;
            }

            const importedStatementIds = new Set([startingStatement.id]);

            const from = getUnixTime(startingStatement.time);

            for (const account of clientData.accounts) {
                let to = undefined;

                while (true) {
                    const statements = await getMonobankStatements(account.id, from, to);

                    for (const statement of statements) {
                        if (importedStatementIds.has(statement.id)) {
                            continue;
                        }
                        importedStatementIds.add(statement.id);

                        const transaction = await monobankToFireflyTransaction(account.id, statement);

                        fastify.log.info({
                            transaction
                        });

                        await createFireflyTransaction(transaction);
                    }

                    if (statements.length < 500) {
                        break;
                    }
                    to = getUnixTime(statements.at(-1)!.time);
                }
            }

            fastify.log.info(`Recovered ${importedStatementIds.size - 1} transactions`);

            return;
        }
    }
}

async function setWebook(url: string) {
    await monobankClient.post('personal/webhook', {
        json: {
            webHookUrl: url,
        },
    });
}

fastify.get('*', async () => {
    return '';
});

fastify.post('*', async request => {
    const { data: { account: monoAccountId, statementItem } } = z.object({
        type: z.literal('StatementItem'),
        data: z.object({
            account: z.string(),
            statementItem: statementItemSchema,
        }),
    }).parse(request.body);

    fastify.log.info({
        account: monoAccountId,
        statementItem
    });

    const transaction = await monobankToFireflyTransaction(monoAccountId, statementItem);

    fastify.log.info({
        transaction
    });

    await createFireflyTransaction(transaction);
});

(async () => {
    try {
        await recover();

        fastify.log.info('recovery done');
    } catch (error) {
        fastify.log.warn(error, 'recovery failed');
    }

    if (config.monobank.webhookUrl) {
        try {
            await setWebook(config.monobank.webhookUrl);

            fastify.log.info('webhook set');
        } catch (error) {
            fastify.log.warn(error, 'failed to set webhook');
        }
    }
})();

try {
    await fastify.listen(config.server);
} catch (e) {
    fastify.log.error(e);
    process.exit(1);
}
