# openapi2rpc-ts

OpenAPI 3.x（YAML / JSON）の定義から、**gRPC ライクな TypeScript クライアント**を生成するツールです。

通信は普通の HTTP/JSON（fetch）のままで、呼び出し側のコードは gRPC のように書けます。

- tag ごとに **サービス**（`PetsService`）を作る
- 各 API は **1 リクエスト・1 レスポンス**のメソッド（`getPet(request): Promise<GetPetResponse>`）
- path / query / header パラメータと body を **1 つのリクエストメッセージ**にまとめる
- エラーは HTTP ステータスではなく **gRPC ステータスコード**（`Code.NOT_FOUND` など）で扱う
- **CallOptions**（metadata / deadline / cancel）と **インターセプター**が使える

```ts
import { createClients, createFetchTransport, Code, RpcError } from './gen/petstore.js';

const clients = createClients(
  createFetchTransport({
    baseUrl: 'https://api.example.com/v1',
    metadata: async () => ({ authorization: `Bearer ${await getToken()}` }),
  }),
);

try {
  const pet = await clients.pets.getPet({ petId: 42 }, { timeoutMs: 3000 });
  console.log(pet.name);
} catch (err) {
  if (err instanceof RpcError && err.code === Code.NOT_FOUND) {
    // ...
  }
}
```

## 使い方

```bash
npx openapi2rpc-ts -i openapi.yaml -o src/gen/api.ts
```

| オプション | 説明 |
|---|---|
| `-i, --input <file>` | OpenAPI 定義（YAML / JSON）。`-` で標準入力から読む |
| `-o, --output <file>` | 出力先（省略時は標準出力） |
| `--runtime-import <module>` | ランタイムを埋め込まず、指定モジュールから import する |
| `--emit-runtime <file>` | ランタイムを別ファイルとして書き出す |

デフォルトでは、ランタイム（`Code` / `RpcError` / `createFetchTransport` など）を生成ファイルに埋め込みます。そのため、出力ファイルは 1 つで完結し、実行時の依存パッケージもありません。

複数の API 定義からクライアントを作るときは、ランタイムを 1 ファイルにまとめて共有できます。

```bash
npx openapi2rpc-ts --emit-runtime src/gen/rpc-runtime.ts
npx openapi2rpc-ts -i users.yaml -o src/gen/users.ts --runtime-import ./rpc-runtime.js
npx openapi2rpc-ts -i billing.yaml -o src/gen/billing.ts --runtime-import ./rpc-runtime.js
```

プログラムからも呼べます。

```ts
import { generateFromText } from 'openapi2rpc-ts';

const { code, warnings } = generateFromText(yamlText, { runtimeImport: './rpc-runtime.js' });
```

## 生成されるもの

[`test/fixtures/petstore.yaml`](test/fixtures/petstore.yaml) から生成した [`test/fixtures/petstore.generated.ts`](test/fixtures/petstore.generated.ts) が実例です。

| OpenAPI | 生成される TypeScript |
|---|---|
| `components.schemas` | メッセージ型（object は `interface`、それ以外は `type`） |
| 文字列の `enum` | union 型と、同名の定数オブジェクト（`PetStatus.AVAILABLE`） |
| tag | サービスのインターフェース `XxxService` / HTTP 対応表 `XxxServiceDefinition` / クライアント `XxxServiceClient` |
| operation | `XxxRequest` / `XxxResponse` とメソッド |
| 全体 | `createClients(transport)`（全サービスのクライアントをまとめて作る） |

```ts
/** Request message for `getPet`. */
export interface GetPetRequest {
  /** @in path `petId` */
  petId: number;
}
export type GetPetResponse = Pet;

export interface PetsService {
  /** Get a pet — `GET /pets/{petId}` */
  getPet(request: GetPetRequest, options?: CallOptions): Promise<GetPetResponse>;
  // ...
}
```

### 命名ルール

- **サービス名**：最初の tag を PascalCase にして `Service` を付けます。tag がない操作は `DefaultService` に入ります。
- **メソッド名**：`operationId` を camelCase にしたものです。`operationId` がなければ、メソッドとパスから作ります（`POST /pets/{petId}/photo` → `postPetsPhotoByPetId`）。
- **リクエストのフィールド名**：パラメータ名を camelCase にします（`X-Request-Id` → `xRequestId`）。HTTP 上の元の名前は `XxxServiceDefinition` に残ります。
- **body**：`body` フィールドに入ります（JSON / `multipart/form-data` / `x-www-form-urlencoded` / テキスト / バイナリ）。
- **レスポンス**：最初の 2xx レスポンスの型です。中身がなければ `Empty`（`google.protobuf.Empty` 相当）になります。
- **名前の衝突回避**：グローバルやランタイムの名前と衝突するスキーマ名は、`Model` を付けて避けます（`Error` → `ErrorModel`）。

### 型の対応

| JSON Schema | TypeScript |
|---|---|
| `string`（`format: binary`） | `string`（`Blob`） |
| `integer` / `number` | `number` |
| `array` | `T[]` |
| `object` + `additionalProperties` | `Record<string, T>` |
| `oneOf` / `anyOf` | union |
| `allOf` | intersection |
| `nullable: true`（3.0） / `type: [T, 'null']`（3.1） | `T \| null` |
| `const` / `enum` | リテラル型 |

## ランタイム

### HTTP ステータスと gRPC コードの対応

| HTTP | Code |
|---|---|
| 400 | `INVALID_ARGUMENT` |
| 401 | `UNAUTHENTICATED` |
| 403 | `PERMISSION_DENIED` |
| 404 | `NOT_FOUND` |
| 408, 504 | `DEADLINE_EXCEEDED` |
| 409 | `ABORTED` |
| 412 | `FAILED_PRECONDITION` |
| 416 | `OUT_OF_RANGE` |
| 429 | `RESOURCE_EXHAUSTED` |
| 499 | `CANCELLED` |
| 501 | `UNIMPLEMENTED` |
| 502, 503 | `UNAVAILABLE` |
| その他の 4xx / 5xx | `FAILED_PRECONDITION` / `INTERNAL` |

そのほかの失敗も次のコードになります。

- **通信エラー**：`UNAVAILABLE`
- **`timeoutMs` 超過**：`DEADLINE_EXCEEDED`
- **`signal` によるキャンセル**：`CANCELLED`

エラーレスポンスの本文は `RpcError.details` に、レスポンスヘッダーは `RpcError.metadata` に入ります。

### インターセプター

```ts
const logging: Interceptor = (next) => async (req) => {
  const started = Date.now();
  try {
    return await next(req);
  } finally {
    console.log(`${req.method.service}/${req.method.name}`, Date.now() - started, 'ms');
  }
};

createFetchTransport({ baseUrl, interceptors: [logging] }); // 配列の先頭が一番外側
```

### テスト用のトランスポート

`Transport` はメソッドが 1 つだけのインターフェースです。HTTP を使わないモックも簡単に作れます。

```ts
const clients = createClients({
  async unary(method, request) {
    if (method.name === 'getPet') return { id: 1, name: 'Pochi', status: 'available' };
    throw new RpcError(Code.UNIMPLEMENTED, method.name);
  },
});
```

生成コードは `strict` / `exactOptionalPropertyTypes` / `verbatimModuleSyntax` などを有効にしても型エラーが出ません。TypeScript 4.9 以上（`satisfies` を使うため）と、`fetch` / `AbortController` / `FormData` が使える環境（Node.js 18 以上 / モダンブラウザ）が必要です。

## 未対応（今後の候補）

- 外部ファイルへの `$ref`（`./other.yaml#/...`）
- Swagger 2.0
- ストリーミング（SSE など）
- サーバー側のスタブ生成
- `int64` を `bigint` / `string` にするオプション

## 開発

```bash
npm install
npm test          # vitest（スナップショット、生成コードの型チェック、ランタイムの動作）
npm run typecheck
npm run build
npm run generate:example   # test/fixtures/petstore.generated.ts を作り直す
```

スナップショットを更新するときは `npx vitest run -u` を実行します。
