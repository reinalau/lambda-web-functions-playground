# Medir CPU activa, vida del entorno y costo de arranque (CloudWatch Logs Insights)

Consultas genéricas para cualquier Lambda Web Function (el BFF, el agente, etc.). Resumen el consumo tras una prueba de carga leyendo los eventos que la plataforma escribe en el log group `.local` de cada servicio.

La idea del artículo: en una Web Function se paga **CPU activa**, no tiempo de reloj. Con tráfico que espera mucho I/O (inventory, DynamoDB, un LLM), los segundos de CPU son una fracción de la vida del entorno. Estas consultas dan los números para afirmarlo con datos.

Las consultas van en archivos `.txt` que se pasan con `file://`, porque el query string multilínea con comillas se rompe al escaparlo en la terminal. Comandos en bash / git bash; `MSYS_NO_PATHCONV=1` evita que la ruta `/aws/...` se convierta en Windows.

## Antes de medir

Los `platform.invokeReport` se emiten cuando el entorno **cierra** (escala a cero), no al terminar la prueba. Esperá 2-3 minutos tras la carga a que todo escale a cero, o te van a faltar entornos en el total.

La ventana de la consulta tiene que caer dentro de la retención del log group (acá, 1 día) y después de su creación. Lo más simple es tomar el instante de creación del log group como inicio:

```bash
SERVICE=orders   # o inventory, o weather-agent

START=$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/web/$SERVICE.local" \
  --query 'logGroups[0].creationTime' --output text)
START=$((START / 1000))        # creationTime viene en milisegundos
END=$((START + 3600))          # ventana de 1 hora
```

## 1. CPU activa vs. vida del entorno

```bash
cat > q1.txt <<'EOF'
filter type = "platform.invokeReport"
| stats sum(record.metrics.totalRequests)      as requests,
        sum(record.metrics.totalCpuTimeMs)     as cpu_ms,
        sum(record.metrics.totalDurationMs)    as env_life_ms,
        max(record.metrics.concurrentRequests) as peak_concurrency,
        max(record.metrics.maxMemoryUsageMb)   as peak_mem_mb,
        count(*)                               as environments
EOF

QID=$(MSYS_NO_PATHCONV=1 aws logs start-query \
  --log-group-name "/aws/lambda/web/$SERVICE.local" \
  --start-time "$START" --end-time "$END" \
  --query-string file://q1.txt --query queryId --output text)

sleep 8
aws logs get-query-results --query-id "$QID"
```

Lectura de los campos:

- **requests**: peticiones atendidas. Puede diferir de lo que disparaste; la telemetría es best-effort.
- **cpu_ms**: CPU activa del período de servicio de todos los entornos (sin contar el arranque, que va en la consulta 2).
- **env_life_ms**: suma de la vida de servicio de cada entorno (`totalDurationMs`). No es la duración de la prueba: los entornos corren en paralelo y se solapan.
- **cpu_ms / env_life_ms** (calculalo aparte): fracción de la vida del entorno con CPU activa. El resto es tiempo sin CPU, o sea espera de I/O **y** ocio entre requests. Es "fraccion no-CPU", no "esperando I/O".
- **peak_concurrency**: pico de peticiones simultaneas en un entorno.
- **peak_mem_mb**: memoria pico. La memoria se factura durante toda `env_life_ms`.
- **environments**: cuantos entornos participaron (un `invokeReport` por entorno).

## 2. CPU de inicializacion (costo fijo por entorno)

El CPU de arranque (Node + carga del SDK + primera conexion) se reporta aparte en `platform.initReport`, no dentro del serving. Para ver cuanto pesa:

```bash
cat > q2.txt <<'EOF'
filter type = "platform.initReport"
| stats count(*)                            as inits,
        sum(record.metrics.totalCpuTimeMs)  as init_cpu_ms,
        avg(record.metrics.totalCpuTimeMs)  as init_cpu_ms_avg,
        avg(record.metrics.totalDurationMs) as init_wall_ms_avg
EOF

QID=$(MSYS_NO_PATHCONV=1 aws logs start-query \
  --log-group-name "/aws/lambda/web/$SERVICE.local" \
  --start-time "$START" --end-time "$END" \
  --query-string file://q2.txt --query queryId --output text)

sleep 8
aws logs get-query-results --query-id "$QID"
```

Compará `init_cpu_ms` (consulta 2) con `cpu_ms` (consulta 1): si el arranque pesa parecido al serving, buena parte del costo es fijo por entorno, no por request. Esto importa cuando Lambda abre muchos entornos para absorber un pico.

## 3. Separar costo fijo por entorno vs. costo por request

Las consultas de arriba dan totales. Para aislar el CPU por request, acotá la variable (desde la raiz del proyecto, con `$ORDERS_DOMAIN` resuelto). Entre corridas esperá el scale-to-zero y recalculá `START`/`END`.

```bash
# Un request, un entorno (costo minimo por entorno)
bash load-test/run-load.sh "$ORDERS_DOMAIN" 1 1

# 200 requests secuenciales (concurrencia 1 -> mismo entorno caliente)
bash load-test/run-load.sh "$ORDERS_DOMAIN" 200 1
```

El costo marginal por request es aproximadamente `(cpu_200 - cpu_1) / 199`. Repetí con concurrencia 10, 50 y 128 y mirá como cambian `environments` y `cpu_ms` en la consulta 1: mas concurrencia abre mas entornos, y cada entorno suma su CPU de arranque.

> La documentacion define `totalCpuTimeMs` como el CPU del periodo de servicio, pero no detalla si el modelo de precios factura ademas el CPU de inicializacion. Confirmalo en la pagina de precios de Lambda antes de sacar conclusiones de costo.

## 4. Latencia observada por el cliente

`run-load.sh` imprime al final la suma de latencia observada por el cliente (de `curl %{time_total}`) y el tiempo de reloj total. Esa latencia incluye DNS y TLS en cada llamada (curl abre conexion nueva cada vez), asi que es un techo, no la latencia del servidor.

> Al terminar, borrá los `q1.txt` y `q2.txt` temporales.

## Fuentes

- [Monitoring Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring.html)
- [System log event schema for Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-logging-system-log-schema.html)
