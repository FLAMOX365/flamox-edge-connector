export type EdgeConnectorHttpResponse = {
  statusCode: number;
  headers?: {
    [key: string]: (string)[];
  };
  body?: (string) | (null);
};
