import MintClient, { Transaction } from './MintClient';
import AmazonClient, { Order, Return } from './AmazonClient';
import Joiner, { JoinedRecord } from './Joiner';
import 'source-map-support/register';

const START_DATE = new Date('2023-03-01T00:00:00Z');
const BUFFERED_START_DATE = new Date(START_DATE.getTime() - 14 * 24 * 60 * 60 * 1000);

interface Options {
  amazonOrdersPaths: string[];
  isDryrun: boolean;
  isRefreshCredentials: boolean;
}
const options: Options = {
  amazonOrdersPaths: [],
  isDryrun: false,
  isRefreshCredentials: false,
};

const USAGE_MESSAGE =
  'Usage: yarn start <path-to-amazon-orders-1> <path-to-amazon-orders-2> [--dry-run] [--refresh-creds]';
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    if (arg === '--dry-run') {
      options.isDryrun = true;
    } else if (arg === '--refresh-creds') {
      options.isRefreshCredentials = true;
    } else {
      throw new Error(`Unknown arg: ${arg} ${USAGE_MESSAGE}`);
    }
  } else {
    options.amazonOrdersPaths.push(arg);
  }
}
if (options.amazonOrdersPaths.length === 0) {
  throw new Error(`No Amazon orders path(s) provided. ${USAGE_MESSAGE}`);
}

(async () => {
  const mintClient = new MintClient();
  if (options.isRefreshCredentials) {
    await mintClient.clearCredentials();
  }
  const transactions = await mintClient.getTransactions(START_DATE);

  console.log('Mint Records');
  console.log('==============');
  logTransactions(transactions);

  const amazonClient = new AmazonClient(options.amazonOrdersPaths);
  const orders = await amazonClient.getOrders(BUFFERED_START_DATE);

  console.log('Amazon Records');
  console.log('==============');
  logAmazonOrders(orders);

  const { returns, remainingReturns } = await amazonClient.getReturns(orders, BUFFERED_START_DATE);

  console.log('Amazon Returns');
  console.log('==============');
  logAmazonReturns(returns);

  console.log('Unmatched Amazon Returns');
  console.log('==============');
  logAmazonReturns(remainingReturns);

  const { joinedRecords, remainingMintTransactions, remainingAmazonOrders, remainingAmazonReturns } = Joiner.joinOrders(
    transactions,
    orders,
    returns,
  );

  console.log('Joined Records');
  console.log('==============');
  logJoinedRecords(joinedRecords);

  console.log('Remaining Mint Transactions');
  console.log('==============');
  logTransactions(remainingMintTransactions);

  console.log('Remaining Amazon Orders');
  console.log('==============');
  logAmazonOrders(remainingAmazonOrders.filter((order) => order.orderDate.getTime() >= START_DATE.getTime()));

  console.log('Remaining Amazon Returns');
  console.log('==============');
  logAmazonReturns(
    remainingAmazonReturns.filter((returnRecord) => returnRecord.returnDate.getTime() >= START_DATE.getTime()),
  );

  if (options.isDryrun) {
    console.log('Not updating Mint transactions in dryrun mode');
    console.log(`${joinedRecords.filter(({ isUnmodified }) => !isUnmodified).length} records would have been updated.`);
  } else {
    console.log('Updating Mint Transactions...');
    for (const joinedRecord of joinedRecords) {
      if (joinedRecord.isUnmodified) {
        continue;
      }
      await mintClient.updateTransaction(joinedRecord);
    }
  }
})();

function formatNumber(value: number): string {
  return value.toFixed(2).padStart(7);
}

function logTransactions(transactions: Transaction[]) {
  if (transactions.length === 0) {
    console.log('NONE');
  }
  for (const transaction of transactions) {
    console.log(transaction.date, formatNumber(transaction.amount));
    for (const childTransaction of transaction.children) {
      console.log('    ', formatNumber(childTransaction.amount), childTransaction.description.substring(0, 140));
    }
  }
}

function logAmazonOrders(orders: Order[]) {
  if (orders.length === 0) {
    console.log('NONE');
  }
  for (const order of orders) {
    console.log(order.orderDate, order.orderId);
    for (const shipment of order.shipments) {
      console.log('  ', shipment.shipmentDate, formatNumber(shipment.amount), shipment.trackingId);
      for (const item of shipment.items) {
        console.log('    ', formatNumber(item.amount), item.description.substring(0, 140));
      }
    }
  }
}

function logAmazonReturns(returns: Return[]) {
  if (returns.length === 0) {
    console.log('NONE');
  }
  for (const returnRecord of returns) {
    console.log(returnRecord.returnDate, formatNumber(returnRecord.amount), returnRecord.orderId);
    for (const item of returnRecord.items) {
      console.log('  ', formatNumber(item.amount), item.description.substring(0, 140));
    }
  }
}

function logJoinedRecords(joinedRecords: JoinedRecord[]) {
  if (joinedRecords.length === 0) {
    console.log('NONE');
  }
  for (const record of joinedRecords) {
    if (!record.isUnmodified) {
      console.log('[MODIFIED]');
    }
    console.log(record.orderDate, formatNumber(record.amount), record.orderId, record.mintTransactionId);
    for (const item of record.items) {
      console.log('    ', formatNumber(item.amount), item.description);
    }
  }
}
