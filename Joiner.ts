import { Transaction } from './MintClient';
import { Order, Return, Shipment } from './AmazonClient';
import cloneDeep from 'lodash/cloneDeep';
import { amountsMatch, combinations, getTotalAmount } from './utils';

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DESCRIPTION_PREFIX = 'Amazon - ';
const GIFT_CARD_DESCRIPTION = 'Gift Card';

interface JoinedRecordItem {
  trackingId: string;
  description: string;
  amount: number;
}

export interface JoinedRecord {
  mintTransactionId: string;
  orderId: string;
  orderDate: Date;
  amount: number;
  items: JoinedRecordItem[];
  isUnmodified: boolean;
}

export interface GiftCard {
  orderId: string;
  amount: number;
}

function getTimeDelta(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime());
}

function removeItem<T>(array: T[], item: T) {
  const index = array.indexOf(item);
  if (index < 0) {
    return;
  }
  array.splice(index, 1);
}

function inRange(candidate: Date, start: Date, durationMs: number = WINDOW_MS): boolean {
  return candidate.getTime() >= start.getTime() && candidate.getTime() <= start.getTime() + durationMs;
}

/**
 * Get mint transaction matching the group of shipments
 */
function getExactMatches(
  shipments: Shipment[],
  amount: number,
  amazonOrder: Order,
  amazonReturns: Return[],
  mintTransactions: Transaction[],
): Transaction[] {
  const mintTransaction = mintTransactions
    .filter((mintTransactions) => mintTransactions.amount < 0)
    .filter((mintTransaction) => inRange(mintTransaction.date, amazonOrder.orderDate))
    .filter((mintTransaction) => amountsMatch(mintTransaction.amount, amount))
    .sort((a, b) => getTimeDelta(a.date, amazonOrder.orderDate) - getTimeDelta(b.date, amazonOrder.orderDate))[0];
  return mintTransaction ? [mintTransaction] : [];
}

/**
 * Get combination of mint transactions that match the group of shipments
 */
function getCombinationMatches(
  shipments: Shipment[],
  amount: number,
  amazonOrder: Order,
  amazonReturns: Return[],
  mintTransactions: Transaction[],
): Transaction[] {
  const transactionCombinations = combinations(
    mintTransactions
      .filter((mintTransactions) => mintTransactions.amount < 0)
      .filter((mintTransaction) => inRange(mintTransaction.date, amazonOrder.orderDate))
      .sort((a, b) => getTimeDelta(a.date, amazonOrder.orderDate) - getTimeDelta(b.date, amazonOrder.orderDate)),
  ).filter((combination) => combination.length >= 2);
  for (const transactionCombination of transactionCombinations) {
    const combinationAmount = getTotalAmount(transactionCombination);
    if (amountsMatch(combinationAmount, amount)) {
      return transactionCombination;
    }
  }
  return [];
}

/**
 * Get mint transaction with the amount less than but closest to the shipments amount
 */
function getGiftCardMatches(
  shipments: Shipment[],
  amount: number,
  amazonOrder: Order,
  amazonReturns: Return[],
  mintTransactions: Transaction[],
): Transaction[] {
  if (!amazonOrder.usedGiftCard) {
    return [];
  }
  const mintTransaction = mintTransactions
    .filter((mintTransactions) => mintTransactions.amount < 0)
    .filter((mintTransaction) => inRange(mintTransaction.date, amazonOrder.orderDate))
    .filter((mintTransaction) => mintTransaction.amount > amount)
    // Pick the transaction with the least difference to the amount
    .sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount))[0];
  if (!mintTransaction) {
    return [];
  }

  // Add a gift card "item" so the transaction balances
  const giftCardAmount = amount - mintTransaction.amount;
  const matchingReturn = amazonReturns.find((returnRecord) => amountsMatch(returnRecord.amount, -giftCardAmount));
  if (matchingReturn) {
    shipments[0].items.push(
      ...matchingReturn.items.map((item) => ({
        description: item.description,
        amount: -item.amount,
      })),
    );
    removeItem(amazonReturns, matchingReturn);
  } else {
    shipments[0].items.push({
      description: GIFT_CARD_DESCRIPTION,
      amount: Number((-giftCardAmount).toFixed(2)),
    });
  }

  return [mintTransaction];
}

function transactionMatches(joinedRecord: JoinedRecord, mintTransaction: Transaction) {
  if (mintTransaction.children.length !== joinedRecord.items.length) {
    return false;
  }
  for (const item of joinedRecord.items) {
    const match = mintTransaction.children.find(
      (child) => amountsMatch(child.amount, item.amount) && child.description.trim() === item.description.trim(),
    );
    if (!match) {
      return false;
    }
  }
  return true;
}

export default class Joiner {
  static joinOrders(
    mintTransactions: Transaction[],
    amazonOrders: Order[],
    amazonReturns: Return[],
  ): {
    joinedRecords: JoinedRecord[];
    remainingMintTransactions: Transaction[];
    remainingAmazonOrders: Order[];
    remainingAmazonReturns: Return[];
  } {
    mintTransactions = cloneDeep(mintTransactions);
    amazonOrders = cloneDeep(amazonOrders);
    // Sort orders by amount from largest to smallest (important for gift card matching)
    amazonOrders = amazonOrders.sort((a, b) => getTotalAmount(b.shipments) - getTotalAmount(a.shipments));
    const joinedRecords: JoinedRecord[] = [];
    const giftCards: GiftCard[] = [];
    for (const matcher of [getExactMatches, getCombinationMatches, getGiftCardMatches]) {
      for (let i = 0; i < amazonOrders.length; i++) {
        const amazonOrder = amazonOrders[i];
        let dirty = true;
        while (dirty) {
          dirty = false;
          const shipmentCombinations = combinations(amazonOrder.shipments).reverse();
          for (const shipments of shipmentCombinations) {
            const amount = getTotalAmount(shipments);
            const matches = matcher(shipments, amount, amazonOrder, amazonReturns, mintTransactions);
            if (matches.length > 0) {
              const items: JoinedRecordItem[] = shipments.flatMap((shipment) =>
                shipment.items.map((item) => ({
                  trackingId: shipment.trackingId,
                  description: DESCRIPTION_PREFIX + item.description,
                  amount: item.amount,
                })),
              );
              for (const match of matches) {
                let matchItems: JoinedRecordItem[] = [];

                // Try to find an exact set of items matching the transaction
                for (const itemCombination of combinations(items)) {
                  const amount = getTotalAmount(itemCombination);
                  if (amountsMatch(amount, match.amount)) {
                    matchItems = itemCombination;
                    for (const item of matchItems) {
                      removeItem(items, item);
                    }
                  }
                }

                // Otherwise just split them across the transactions
                if (matchItems.length === 0) {
                  let remainingAmount = match.amount;
                  while (items.length > 0 && remainingAmount < 0 /* negative means a balance is remaining */) {
                    const item = items[0];
                    matchItems.push(item);
                    remainingAmount -= item.amount;
                    removeItem(items, item);
                  }
                  if (!amountsMatch(remainingAmount, 0)) {
                    matchItems.push({
                      trackingId: 'none',
                      description: DESCRIPTION_PREFIX + 'Balance Adjust',
                      amount: remainingAmount,
                    });
                  }
                }

                for (const item of matchItems) {
                  if (item.description === DESCRIPTION_PREFIX + GIFT_CARD_DESCRIPTION) {
                    giftCards.push({ orderId: amazonOrder.orderId, amount: item.amount });
                  }
                }

                const joinedRecord: JoinedRecord = {
                  mintTransactionId: match.id,
                  orderId: amazonOrder.orderId,
                  orderDate: amazonOrder.orderDate,
                  amount: match.amount,
                  items: matchItems,
                  isUnmodified: false,
                };
                joinedRecord.isUnmodified = transactionMatches(joinedRecord, match);
                joinedRecords.push(joinedRecord);
                removeItem(mintTransactions, match);
              }
              for (const shipment of shipments) {
                removeItem(amazonOrder.shipments, shipment);
              }
              if (amazonOrder.shipments.length === 0) {
                removeItem(amazonOrders, amazonOrder);
                i--;
              }
              dirty = true;
              break;
            }
          }
        }
      }
    }

    amazonReturns = cloneDeep(amazonReturns);
    for (let i = 0; i < amazonReturns.length; i++) {
      const amazonReturn = amazonReturns[i];
      for (const transaction of mintTransactions) {
        const giftCard = giftCards.find((giftCard) =>
          amountsMatch(transaction.amount, amazonReturn.amount - giftCard.amount),
        );
        if (giftCard || amountsMatch(transaction.amount, amazonReturn.amount)) {
          const joinedRecord: JoinedRecord = {
            mintTransactionId: transaction.id,
            orderId: amazonReturn.orderId,
            orderDate: amazonReturn.returnDate,
            amount: transaction.amount,
            items: amazonReturn.items.map((item) => ({
              trackingId: 'none',
              description: DESCRIPTION_PREFIX + item.description,
              amount: -item.amount,
            })),
            isUnmodified: false,
          };
          if (giftCard) {
            joinedRecord.items.push({
              trackingId: 'none',
              description: DESCRIPTION_PREFIX + GIFT_CARD_DESCRIPTION,
              amount: -giftCard.amount,
            });
            // removeItem(giftCards, giftCard); This probably should be used but there is an instance where it is better to keep it
          }
          joinedRecord.isUnmodified = transactionMatches(joinedRecord, transaction);
          joinedRecords.push(joinedRecord);
          removeItem(mintTransactions, transaction);
          removeItem(amazonReturns, amazonReturn);
          i--;
          break;
        }
      }
    }

    return {
      joinedRecords: joinedRecords.sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime()),
      remainingMintTransactions: mintTransactions,
      remainingAmazonOrders: amazonOrders,
      remainingAmazonReturns: amazonReturns,
    };
  }
}
