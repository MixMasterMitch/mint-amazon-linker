import axios, { AxiosError, AxiosResponse } from 'axios';
import { JoinedRecord } from './Joiner';
import MintCredentialsProvider from './MintCredentialsProvider';

interface RawTransactions {
  Transaction: Array<{
    id: string;
    parentId?: string;
    description: string;
    date: string;
    amount: number;
    fiData?: {
      amount: number;
      description: string;
    };
  }>;
}

export interface ChildTransaction {
  description: string;
  amount: number;
}
export interface Transaction {
  id: string;
  amount: number;
  date: Date;
  children: ChildTransaction[];
}

const DESCRIPTION_KEYWORDS = ['amazon', 'amzn'];
const DESCRIPTION_ANTI_KEYWORDS = ['web services', 'clinic'];
const MINT_API_PATH = 'https://mint.intuit.com/pfm/v1';

export default class MintClient {
  private credentialsProvider = new MintCredentialsProvider();

  private async getHeaders(): Promise<Record<string, string>> {
    const credentials = await this.credentialsProvider.getCredentials();
    if (credentials === null) {
      return {};
    }
    return {
      cookie: credentials.cookie,
      authorization: `Intuit_APIKey intuit_apikey=${credentials.apiKey}, intuit_apikey_version=1.0`,
      accept: 'application/json',
    };
  }

  async getTransactions(startDate: Date): Promise<Transaction[]> {
    const response: AxiosResponse<RawTransactions> = await this.ensureAuthorized(async () =>
      axios.get(`${MINT_API_PATH}/transactions`, {
        params: {
          limit: 100000,
          fromDate: startDate.toISOString(),
        },
        headers: await this.getHeaders(),
      }),
    );
    return response.data.Transaction.filter((transaction) => {
      if (!transaction.fiData) {
        return false;
      }
      const originalDescription = transaction.fiData.description.toLowerCase();
      for (const keyword of DESCRIPTION_KEYWORDS) {
        if (originalDescription.includes(keyword)) {
          let matches = true;
          for (const antiKeyword of DESCRIPTION_ANTI_KEYWORDS) {
            if (originalDescription.includes(antiKeyword)) {
              matches = false;
              break;
            }
          }
          if (matches) {
            return true;
          }
        }
      }
      return false;
    })
      .map(({ id, parentId, amount, description, date }) => ({
        id: parentId ?? id,
        amount,
        date: new Date(date),
        children: [{ description, amount }],
      }))
      .reduce<Transaction[]>((results, transaction) => {
        const existingTransaction = results.find((result) => result.id === transaction.id);
        if (!existingTransaction) {
          results.push(transaction);
        } else {
          existingTransaction.amount += transaction.amount;
          existingTransaction.children.push(...transaction.children);
        }
        return results;
      }, [])
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  async updateTransaction(joinedRecord: JoinedRecord): Promise<void> {
    let data: {
      type: 'CashAndCreditTransaction';
      description?: string;
      splitData: { children: { amount: number; description: string }[] };
    };
    if (joinedRecord.items.length === 1) {
      data = {
        description: joinedRecord.items[0].description,
        type: 'CashAndCreditTransaction',
        splitData: { children: [] },
      };
    } else {
      data = {
        type: 'CashAndCreditTransaction',
        splitData: {
          children: joinedRecord.items.map((item) => ({
            amount: item.amount * (joinedRecord.amount > 0 ? -1 : 1),
            description: item.description,
          })),
        },
      };
    }
    await this.ensureAuthorized(async () =>
      axios.put(`${MINT_API_PATH}/transactions/${joinedRecord.mintTransactionId}`, data, {
        headers: await this.getHeaders(),
      }),
    );
  }

  async clearCredentials() {
    await this.credentialsProvider.clearCredentials();
  }

  async ensureAuthorized<T>(func: () => Promise<AxiosResponse<T>>): Promise<AxiosResponse<T>> {
    const credentials = await this.credentialsProvider.getCredentials();
    if (!credentials) {
      await this.credentialsProvider.refreshCredentials();
      return await func();
    } else {
      try {
        return await func();
      } catch (e) {
        if (e instanceof AxiosError && e.response?.statusText === 'Unauthorized') {
          await this.credentialsProvider.refreshCredentials();
          return await func();
        } else {
          throw e;
        }
      }
    }
  }
}
