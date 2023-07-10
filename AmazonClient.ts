import fs from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse';
import { amountsMatch, combinations, getTotalAmount } from './utils';

export interface Item {
  description: string;
  amount: number;
}

export interface Shipment {
  trackingId: string;
  shipmentDate: Date;
  amount: number;
  items: Item[];
}

export interface Order {
  orderId: string;
  orderDate: Date;
  usedGiftCard: boolean;
  shipments: Shipment[];
}

interface FlatItem {
  orderId: string;
  orderDate: Date;
  usedGiftCard: boolean;
  trackingId: string;
  shipmentDate: Date;
  description: string;
  amount: number;
}

export interface Return {
  orderId: string;
  returnDate: Date;
  amount: number;
  items: Item[];
}

interface FlatReturn {
  orderId: string;
  returnDate: Date;
  amount: number;
}

function toDate(dateString: string): Date {
  return new Date(dateString.substring(0, 10));
}

const EXCLUDED_ORDERS = ['111-0256590-5355439'];

export default class AmazonClient {
  constructor(private orderDataPaths: string[]) {}

  async getOrders(startDate: Date): Promise<Order[]> {
    const allOrders: Order[] = [];
    for (const orderDataPath of this.orderDataPaths) {
      const parser = fs.createReadStream(join(orderDataPath, 'Retail.OrderHistory.1/Retail.OrderHistory.1.csv')).pipe(
        parse({
          delimiter: ',',
          from_line: 2,
          relax_quotes: true,
          on_record: (record) => {
            if (record[0] === 'panda01') {
              return null;
            }
            return {
              orderId: record[1],
              orderDate: toDate(record[2]),
              usedGiftCard: record[15].toLowerCase().includes('gift'),
              trackingId: record[22],
              shipmentDate: toDate(record[18]),
              description: record[23],
              amount: -parseFloat(record[9]),
            };
          },
        }),
      );
      const records: FlatItem[] = [];
      for await (const record of parser) {
        if (record.orderDate.getTime() < startDate.getTime()) {
          continue;
        }
        records.push(record);
      }
      const orders = records.reduce<Order[]>((orders, flatItem) => {
        let order: Order | undefined = orders.find(({ orderId }) => orderId === flatItem.orderId);
        if (!order) {
          order = {
            orderId: flatItem.orderId,
            orderDate: flatItem.orderDate,
            usedGiftCard: flatItem.usedGiftCard,
            shipments: [],
          };
          orders.push(order);
        }

        let shipment: Shipment | undefined = order.shipments.find(
          ({ trackingId }) => trackingId === flatItem.trackingId,
        );
        if (!shipment) {
          shipment = {
            trackingId: flatItem.trackingId,
            shipmentDate: flatItem.shipmentDate,
            amount: 0,
            items: [],
          };
          order.shipments.push(shipment);
        }

        shipment.amount += flatItem.amount;
        shipment.items.push({
          description: flatItem.description,
          amount: flatItem.amount,
        });

        return orders;
      }, []);
      allOrders.push(
        ...orders
          .filter((order) => !EXCLUDED_ORDERS.includes(order.orderId))
          .sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime()),
      );
    }
    return allOrders;
  }

  async getReturns(orders: Order[], startDate: Date): Promise<{ returns: Return[]; remainingReturns: Return[] }> {
    const returns: Return[] = [];
    const unmatchedReturns: Return[] = [];
    for (const orderDataPath of this.orderDataPaths) {
      const parser = fs
        .createReadStream(join(orderDataPath, 'Retail.OrdersReturned.Payments.1/Retail.OrdersReturned.Payments.1.csv'))
        .pipe(
          parse({
            delimiter: ',',
            from_line: 2,
            relax_quotes: true,
            on_record: (record) => ({
              orderId: record[0],
              returnDate: toDate(record[2]),
              amount: parseFloat(record[4]),
            }),
          }),
        );
      const records: FlatReturn[] = [];
      for await (const record of parser as unknown as FlatReturn[]) {
        if (record.returnDate.getTime() < startDate.getTime()) {
          continue;
        }
        records.push(record);
      }
      for (const record of records) {
        const completeReturn: Return = {
          orderId: record.orderId,
          returnDate: record.returnDate,
          amount: record.amount,
          items: [],
        };

        const order = orders.find(({ orderId }) => orderId === record.orderId);
        if (!order) {
          unmatchedReturns.push(completeReturn);
          continue;
        }

        const orderItems = order.shipments.flatMap((shipment) => shipment.items);
        let foundMatch = false;
        for (const combination of combinations(orderItems)) {
          const amount = getTotalAmount(combination);
          if (amountsMatch(-amount, completeReturn.amount)) {
            completeReturn.items = combination;
            returns.push(completeReturn);
            foundMatch = true;
            break;
          }
        }
        if (!foundMatch) {
          unmatchedReturns.push(completeReturn);
        }
      }
    }
    return { returns, remainingReturns: unmatchedReturns };
  }
}
