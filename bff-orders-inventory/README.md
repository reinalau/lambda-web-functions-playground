# bff-orders-inventory

Dos **Lambda Web Functions** (servidores Express HTTP) que modelan un patrón BFF
+ microservicios, sin IA: solo API y DynamoDB.

- **orders** — BFF/upstream, **público** (`AuthType: ApplicationManaged`).
  Recibe un pedido, reserva stock llamando a `inventory` y persiste el pedido en
  DynamoDB.
- **inventory** — downstream, **privado** (`AuthType: IamAuth`). Expone el stock
  y reserva unidades con un `UpdateItem` condicional que nunca deja el stock en
  negativo (devuelve `409` si no alcanza).

El código de cada servicio vive en `inventory/src/` y `orders/src/`. La IaC con
SAM es una única plantilla en [`sam/`](sam/) que despliega todo el proyecto en un
stack (las dos funciones + las dos tablas + los roles, con el acoplamiento
`orders → inventory` resuelto solo).

## Por qué se usa Lambda Web Functions

- **Alta concurrencia con mucha espera de I/O**: `orders` pasa buena parte del
  tiempo esperando a `inventory` y a DynamoDB. En Web Functions se paga **CPU
  activa**, no el tiempo de espera, así que la concurrencia con I/O sale barata.
- **Servicio-a-servicio seguro**: `inventory` es `IamAuth`, de modo que solo
  quien firma con **SigV4** y tiene permiso IAM puede invocarlo.
- **Escalado independiente**: cada servicio escala por su cuenta; un pico en el
  BFF no obliga a sobredimensionar el inventario.

## Arquitectura

```
Cliente  --POST /orders-->  orders (público, ApplicationManaged)
                               |  SigV4 (service 'lambda', x-amz-content-sha256)
                               v
                           inventory (privado, IamAuth)  -->  DynamoDB (inventory)
                               |
         orders  --PutItem-->  DynamoDB (orders)
```

El cliente llama a `orders` **sin firmar** (endpoint público). `orders` sí firma
su llamada a `inventory` con **SigV4**: `service` = `lambda`, `region` = la del
endpoint, y **toda** petición firmada debe incluir la cabecera
`x-amz-content-sha256` (Lambda la usa como hash del payload y no lee el body).
El rol de `orders` necesita `lambda:InvokeWebFunctionEndpoint` sobre el ARN del
endpoint de `inventory`. Verificable en la doc de AWS:
<https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html>

## Requisitos

- **AWS CLI v2 reciente**, en una versión que incluya los comandos `aws lambda-web`
  (Web Functions es un lanzamiento nuevo). Verificá con `aws lambda-web help`; si
  falla, actualizá: <https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html>
- **Solo si vas a desplegar con SAM**: AWS SAM CLI en su **última versión** (las
  anteriores no conocen el recurso `AWS::Serverless::WebFunction`). Instalá o
  actualizá desde: <https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html>
- Credenciales AWS configuradas (`aws configure`, SSO o variables de entorno) y
  Node.js 22+ para compilar.
- Los comandos estan en git bash


## Pruebas locales

### Tests automáticos

No necesitan AWS: las llamadas a DynamoDB y a `fetch` están simuladas. Cubren el parseo de config, `GET /health`, el `400` por campos faltantes y el `409` por stock insuficiente.

```bash
(cd inventory && npm install && npm test)
(cd orders && npm install && npm test)
```

### Levantar los servidores en local

Compilá y arrancá cada servicio en su puerto, en dos terminales. En local definís vos el `host:port`; en la nube lo provee Lambda.

```bash
# Terminal 1 — inventory en el 3001
cd inventory && npm run build && AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3001 node dist/index.js

# Terminal 2 — orders en el 3000, apuntando al inventory local
cd orders && npm run build && AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 \
  INVENTORY_ENDPOINT=http://127.0.0.1:3001 node dist/index.js
```

La sonda de salud no requiere AWS:

```bash
curl http://127.0.0.1:3001/health   # inventory -> {"status":"healthy"}
curl http://127.0.0.1:3000/health   # orders    -> {"status":"healthy"}
```

El flujo completo (`POST /orders`) también corre en local, pero lee y escribe en las **tablas reales de DynamoDB**, así que necesita credenciales AWS y las tablas creadas (paso 1 del despliegue). La firma SigV4 que `orders` agrega a su llamada a `inventory` se genera igual, pero en local nadie la valida: esa validación la hace la plataforma con `IamAuth`.

## Despliegue en AWS manual (bash)

El CLI usa el login que ya tengas configurado
(`aws configure`, SSO o variables de entorno); no se ponen credenciales en el
proyecto. Ejecuta cada bloque desde la carpeta del servicio indicado.

### 1 — Crear y poblar las dos tablas DynamoDB

```bash
aws dynamodb create-table \
  --table-name inventory \
  --attribute-definitions AttributeName=productId,AttributeType=S \
  --key-schema AttributeName=productId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

aws dynamodb create-table \
  --table-name orders \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# Seed de 2 items en inventory
aws dynamodb put-item --table-name inventory \
  --item '{"productId":{"S":"prod-1"},"productName":{"S":"Wireless mouse"},"available":{"N":"10"}}'
aws dynamodb put-item --table-name inventory \
  --item '{"productId":{"S":"prod-2"},"productName":{"S":"USB-C cable"},"available":{"N":"3"}}'
```

### 2 — Desplegar inventory PRIMERO (IamAuth) y capturar domain + ARN

Desde `inventory/`. Los comandos arman el rol y la política **solos** (región y
cuenta se resuelven con `aws sts get-caller-identity`); no hace falta editar
ningún `.json`.

```bash
cd inventory

npm install && npm run build   # genera dist/index.js

REGION=us-east-1
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Trust policy: deja que Lambda asuma el rol
aws iam create-role \
  --role-name inventory-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

# Logs de CloudWatch
aws iam attach-role-policy \
  --role-name inventory-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Permiso de DynamoDB sobre la tabla inventory (política generada en caliente)
aws iam put-role-policy \
  --role-name inventory-execution-role \
  --policy-name inventory-dynamodb \
  --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
    "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/inventory"
  }]
}
EOF
)"

ROLE_ARN=$(aws iam get-role --role-name inventory-execution-role \
  --query 'Role.Arn' --output text)

aws lambda-web deploy \
  --name inventory \
  --code . \
  --execution-role-arn "$ROLE_ARN" \
  --entry-point dist/index.js \
  --env INVENTORY_TABLE=inventory \
  --auth-type IamAuth \
  --create
```

Captura el domain y el ARN del endpoint para el paso siguiente:

```bash
INVENTORY_DOMAIN=$(aws lambda-web get-web-function-endpoint \
  --function-name inventory --endpoint-name dev \
  --query 'domainName' --output text)

INVENTORY_ENDPOINT_ARN=$(aws lambda-web get-web-function-endpoint \
  --function-name inventory --endpoint-name dev \
  --query 'endpointArn' --output text)
```

### 3 — Desplegar orders con INVENTORY_ENDPOINT y permiso de invocación

Desde `orders/`. Reutiliza `$REGION`, `$ACCOUNT_ID` e `$INVENTORY_ENDPOINT_ARN`
de los pasos anteriores (deben seguir en tu misma sesión de terminal). La
política de `orders` incluye `lambda:InvokeWebFunctionEndpoint` sobre el endpoint
de `inventory`, y se genera **en caliente** con el ARN ya resuelto: no hay que
editar ningún `.json`.

```bash
cd ../orders

npm install && npm run build

aws iam create-role \
  --role-name orders-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name orders-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# DynamoDB (tabla orders) + permiso para invocar el endpoint IamAuth de inventory
aws iam put-role-policy \
  --role-name orders-execution-role \
  --policy-name orders-dynamodb-invoke \
  --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/orders"
    },
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeWebFunctionEndpoint",
      "Resource": "${INVENTORY_ENDPOINT_ARN}"
    }
  ]
}
EOF
)"

ORDERS_ROLE_ARN=$(aws iam get-role --role-name orders-execution-role \
  --query 'Role.Arn' --output text)

aws lambda-web deploy \
  --name orders \
  --code . \
  --execution-role-arn "$ORDERS_ROLE_ARN" \
  --entry-point dist/index.js \
  --env ORDERS_TABLE=orders \
  --env INVENTORY_ENDPOINT="https://$INVENTORY_DOMAIN" \
  --auth-type ApplicationManaged \
  --create

ORDERS_DOMAIN=$(aws lambda-web get-web-function-endpoint \
  --function-name orders --endpoint-name dev \
  --query 'domainName' --output text)
```

> Si abriste una terminal nueva y perdiste las variables, volvé a definir
> `REGION`, `ACCOUNT_ID` e `INVENTORY_ENDPOINT_ARN` (este último con el comando
> `get-web-function-endpoint` del paso 2) antes de correr este bloque.

**Acortar la retención de logs.** Por defecto los *log groups* de CloudWatch no expiran nunca:

```bash
for lg in /aws/lambda/web/inventory /aws/lambda/web/inventory.local \
          /aws/lambda/web/orders /aws/lambda/web/orders.local; do
  MSYS_NO_PATHCONV=1 aws logs put-retention-policy \
    --log-group-name "$lg" --retention-in-days 1
done
```

### 4 — Probar con curl

`orders` es público, así que el cliente **no firma**. Un pedido con stock
suficiente devuelve `201`:

```bash
curl --ssl-no-revoke -X POST "https://$ORDERS_DOMAIN/orders" \
  -H "Content-Type: application/json" \
  -d '{"productId":"prod-1","quantity":2,"customer":"ada"}'
# -> 201 {"id":"...","productId":"prod-1","quantity":2,"customer":"ada","available":8,...}
```

Pedir más de lo disponible dispara el `UpdateItem` condicional en `inventory`,
que devuelve `409` y `orders` lo propaga:

```bash
curl --ssl-no-revoke -X POST "https://$ORDERS_DOMAIN/orders" \
  -H "Content-Type: application/json" \
  -d '{"productId":"prod-2","quantity":99,"customer":"ada"}'
# -> 409 {"error":"insufficient stock"}
```

## Prueba de stress

Scripts en [`load-test/`](load-test/), en bash puro con `curl` (no instalan nada). Corré todo desde la raíz del proyecto (`bff-orders-inventory/`), con `$ORDERS_DOMAIN` ya resuelto (el dominio sin `https://`). Primero sembrá un producto con mucho stock para que la carga no se agote; después dispará los pedidos.

```bash
# 1. Sembrar stock: productId "load-test" con 1.000.000 de unidades
bash load-test/seed-stock.sh

# 2. Marcar el inicio de la corrida (para acotar la consulta de CloudWatch)
RUN_START=$(date +%s)

# 3. Disparar la carga: 500 pedidos en total, 50 en paralelo
bash load-test/run-load.sh "$ORDERS_DOMAIN" 500 50

```

`run-load.sh <dominio> [total] [concurrencia]`: son `[total]` pedidos en total, con como mucho `[concurrencia]` en vuelo a la vez (no "500 concurrentes": 500 en total, 50 simultáneos).

Después, **esperá 1-2 minutos** a que los entornos escalen a cero (los reportes de CPU se emiten al cerrar el entorno) y medí **CPU activa, vida del entorno y costo de arranque** siguiendo [`load-test/cloudwatch-cpu-query.md`](load-test/cloudwatch-cpu-query.md). Usá el `RUN_START` del paso 2 como `--start-time` para no mezclar con corridas anteriores. La consulta es genérica y sirve para cualquier Web Function.

## Despligue en AWS via SAM (IaC)

Se puede desplegar con `AWS::Serverless::WebFunction` (requiere SAM CLI en su última versión, ver Requisitos). 
El paso a paso está en [`sam/README.md`](sam/README.md).

> Para `WebFunction`, SAM **no empaqueta código local**: `CodeUri` debe ser un
> **objeto en S3**. El flujo es: compilar (`npm run build`) → `zip` del artefacto
> → subir a un bucket con *versioning* → tomar el *version id* → pasar
> `CodeBucket`/`CodeKey`/`CodeVersion` al `sam deploy`.


## 🧹 Limpieza del ambiente

Eliminación en orden de las Web Functions, luego los roles/políticas y por último las tablas:

```bash
# 1. Web Functions (incluye endpoints y revisiones)
aws lambda-web delete-web-function --function-name orders
aws lambda-web delete-web-function --function-name inventory

# 2. Roles: quitar política administrada e inline, luego borrar el rol
aws iam detach-role-policy --role-name orders-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role-policy --role-name orders-execution-role \
  --policy-name orders-dynamodb-invoke
aws iam delete-role --role-name orders-execution-role

aws iam detach-role-policy --role-name inventory-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role-policy --role-name inventory-execution-role \
  --policy-name inventory-dynamodb
aws iam delete-role --role-name inventory-execution-role

# 3. Tablas DynamoDB
aws dynamodb delete-table --table-name orders
aws dynamodb delete-table --table-name inventory

# 4. Log groups de CloudWatch (cada servicio tiene el centralizado y el .local)
MSYS_NO_PATHCONV=1 aws logs delete-log-group --log-group-name "/aws/lambda/web/orders"
MSYS_NO_PATHCONV=1 aws logs delete-log-group --log-group-name "/aws/lambda/web/orders.local"
MSYS_NO_PATHCONV=1 aws logs delete-log-group --log-group-name "/aws/lambda/web/inventory"
MSYS_NO_PATHCONV=1 aws logs delete-log-group --log-group-name "/aws/lambda/web/inventory.local"
```

> `delete-web-function` no borra el bucket de código ni los *log groups* de
> CloudWatch; por eso el paso 4 los elimina. (En git bash en Windows,
> `MSYS_NO_PATHCONV=1` evita que la ruta `/aws/...` se convierta a ruta de
> Windows.)

## Troubleshooting

**`MalformedPolicyDocument: Resource <...> must be in ARN format or "*"`.**
Quedó un placeholder sin resolver en la política (típicamente
`$INVENTORY_ENDPOINT_ARN` vacío porque abriste otra terminal). Volvé a definir la
variable y re-aplicá la política al rol que ya existe (sin redesplegar):

```bash
INVENTORY_ENDPOINT_ARN=$(aws lambda-web get-web-function-endpoint \
  --function-name inventory --endpoint-name dev --query 'endpointArn' --output text)
REGION=us-east-1
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws iam put-role-policy \
  --role-name orders-execution-role \
  --policy-name orders-dynamodb-invoke \
  --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["dynamodb:GetItem","dynamodb:PutItem"],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/orders" },
    { "Effect": "Allow", "Action": "lambda:InvokeWebFunctionEndpoint",
      "Resource": "${INVENTORY_ENDPOINT_ARN}" }
  ]
}
EOF
)"
```

**`POST /orders` devuelve 403 al llamar a inventory.** Al rol de `orders` le
falta `lambda:InvokeWebFunctionEndpoint` sobre el endpoint de `inventory`.
Aplicá la política de arriba.

**Ver el nombre del rol de un servicio** (si no lo recordás):

```bash
aws iam list-roles --query "Roles[?contains(RoleName,'orders')].RoleName" --output text
```

**Ver los logs de un servicio** (git bash en Windows necesita `MSYS_NO_PATHCONV=1`):

```bash
MSYS_NO_PATHCONV=1 aws logs tail "/aws/lambda/web/orders.local" --since 10m
```

**`curl` falla con `CRYPT_E_NO_REVOCATION_CHECK` en Windows.** Es del curl del
sistema, no del servidor: agregá `--ssl-no-revoke`.

## Variables de entorno

| Servicio | Variable | Default | Descripción |
| --- | --- | --- | --- |
| inventory | `AWS_REGION` | `us-east-1` | Región de DynamoDB. |
| inventory | `INVENTORY_TABLE` | `inventory` | Tabla de stock (PK `productId`, atributos `productName` y `available`). |
| orders | `AWS_REGION` | `us-east-1` | Región de DynamoDB y de la firma SigV4. |
| orders | `ORDERS_TABLE` | `orders` | Tabla de pedidos (PK `id`). |
| orders | `INVENTORY_ENDPOINT` | — | URL HTTPS del endpoint de `inventory`. |
| ambos | `AWS_LAMBDA_HTTP_ENDPOINT` | `127.0.0.1:3001` / `:3000` | `host:port`; lo provee Lambda, en local lo defines tú. |

> `/ping` está **reservado** por la plataforma de Lambda Web Functions; por eso
> la sonda de salud de ambos servicios es `/health`.
