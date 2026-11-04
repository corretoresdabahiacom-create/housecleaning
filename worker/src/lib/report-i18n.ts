// Column headers, titles and footer for exported reports in EN / PT / ES. Data values are never altered.
type L = 'en' | 'pt' | 'es';
const C: Record<string, [string, string, string]> = {
  full_name: ['Name', 'Nome', 'Nombre'], phone: ['Phone', 'Telefone', 'Teléfono'], email: ['Email', 'E-mail', 'Correo'], language: ['Language', 'Idioma', 'Idioma'],
  status: ['Status', 'Status', 'Estado'], created_at: ['Created', 'Criado em', 'Creado'], name: ['Name', 'Nome', 'Nombre'], customer: ['Customer', 'Cliente', 'Cliente'],
  street: ['Street', 'Endereço', 'Dirección'], unit: ['Unit', 'Unidade', 'Unidad'], city: ['City', 'Cidade', 'Ciudad'], state: ['State', 'Estado', 'Estado'], zip: ['ZIP', 'ZIP', 'ZIP'],
  frequency: ['Frequency', 'Frequência', 'Frecuencia'], price: ['Price', 'Preço', 'Precio'], properties: ['Properties', 'Imóveis', 'Propiedades'], active: ['Active', 'Ativos', 'Activos'],
  property: ['Property', 'Imóvel', 'Propiedad'], start_time: ['Time', 'Horário', 'Hora'], date: ['Date', 'Data', 'Fecha'], service: ['Service', 'Serviço', 'Servicio'],
  helpers: ['Helpers', 'Ajudantes', 'Ayudantes'], helper: ['Helper', 'Ajudante', 'Ayudante'], attendance: ['Attendance', 'Presença', 'Asistencia'], completed: ['Completed', 'Concluídas', 'Completadas'],
  absent: ['Absent', 'Ausências', 'Ausencias'], minutes: ['Minutes', 'Minutos', 'Minutos'], month: ['Month', 'Mês', 'Mes'], gross: ['Gross', 'Bruto', 'Bruto'], discounts: ['Discounts', 'Descontos', 'Descuentos'],
  net: ['Net', 'Líquido', 'Neto'], invoices: ['Invoices', 'Cobranças', 'Facturas'], kind: ['Type', 'Tipo', 'Tipo'], amount: ['Amount', 'Valor', 'Monto'], category: ['Category', 'Categoria', 'Categoría'],
  dre_group: ['DRE line', 'Linha da DRE', 'Línea del estado'], description: ['Description', 'Descrição', 'Descripción'], issue_date: ['Issue date', 'Emissão', 'Emisión'], due_date: ['Due date', 'Vencimento', 'Vencimiento'],
  received: ['Received', 'Recebido', 'Recibido'], payee: ['Payee', 'Favorecido', 'Beneficiario'], paid: ['Paid', 'Pago', 'Pagado'], cleanings: ['Cleanings', 'Limpezas', 'Limpiezas'],
  workdays: ['Workdays', 'Dias trabalhados', 'Días trabajados'], hours: ['Hours', 'Horas', 'Horas'], due: ['Due', 'Devido', 'Adeudado'], balance: ['Balance', 'Saldo', 'Saldo'], refunds: ['Refunds', 'Reembolsos', 'Reembolsos'],
  net_revenue: ['Net revenue', 'Receita líquida', 'Ingresos netos'], helper_labor: ['Helper labor', 'Mão de obra', 'Mano de obra'], direct_supplies: ['Direct supplies', 'Insumos diretos', 'Insumos directos'],
  other_allocated: ['Other allocated', 'Outros alocados', 'Otros asignados'], gross_contribution: ['Gross contribution', 'Contribuição bruta', 'Contribución bruta'], contribution_pct: ['Margin %', 'Margem %', 'Margen %'],
  line: ['Line', 'Linha', 'Línea'],
};
const T: Record<string, [string, string, string]> = {
  customers: ['Customers', 'Clientes', 'Clientes'], properties: ['Properties', 'Imóveis', 'Propiedades'], 'properties-by-city': ['Properties by city', 'Imóveis por cidade', 'Propiedades por ciudad'],
  'properties-by-state': ['Properties by state', 'Imóveis por estado', 'Propiedades por estado'], 'recurring-customers': ['Recurring customers', 'Clientes recorrentes', 'Clientes recurrentes'],
  appointments: ['Cleaning appointments', 'Agendamentos de limpeza', 'Citas de limpieza'], 'completed-cleanings': ['Completed cleanings', 'Limpezas concluídas', 'Limpiezas completadas'],
  'canceled-appointments': ['Canceled appointments', 'Agendamentos cancelados', 'Citas canceladas'], 'helper-assignments': ['Helper assignments', 'Designações de ajudantes', 'Asignaciones de ayudantes'],
  'helper-productivity': ['Helper productivity', 'Produtividade das ajudantes', 'Productividad de ayudantes'], 'revenue-by-period': ['Revenue by period', 'Receita por período', 'Ingresos por período'],
  'revenue-by-property': ['Revenue by property', 'Receita por imóvel', 'Ingresos por propiedad'], 'revenue-by-customer': ['Revenue by customer', 'Receita por cliente', 'Ingresos por cliente'],
  'revenue-by-service': ['Revenue by service', 'Receita por serviço', 'Ingresos por servicio'], 'expenses-by-period': ['Expenses by period', 'Despesas por período', 'Gastos por período'],
  'expenses-by-category': ['Expenses by category', 'Despesas por categoria', 'Gastos por categoría'], receivables: ['Receivables', 'Contas a receber', 'Cuentas por cobrar'],
  payables: ['Payables', 'Contas a pagar', 'Cuentas por pagar'], 'helper-payments': ['Helper payments', 'Pagamentos de ajudantes', 'Pagos a ayudantes'],
  profitability: ['Property profitability', 'Rentabilidade por imóvel', 'Rentabilidad por propiedad'], dre: ['DRE (income statement)', 'DRE (demonstração do resultado)', 'Estado de resultados'], cashflow: ['Cash flow', 'Fluxo de caixa', 'Flujo de caja'],
};
const idx = (l: string | null) => (l === 'pt' ? 1 : l === 'es' ? 2 : 0);
export const reportLang = (l: string | null): L => (['pt', 'es'].includes(l || '') ? (l as L) : 'en');
export const reportTitle = (name: string, l: string | null) => T[name]?.[idx(l)] ?? name;
export const reportFooter = (l: string | null) => ['House Cleaning Management - management report, not a GAAP or tax statement', 'House Cleaning Management - relatório gerencial, não é demonstração GAAP nem fiscal', 'House Cleaning Management - informe de gestión, no es un estado GAAP ni fiscal'][idx(l)];
export const periodLabel = (from: string | null, to: string | null, l: string | null) => (from ? `${from} ${['to', 'a', 'a'][idx(l)]} ${to}` : ['All dates', 'Todas as datas', 'Todas las fechas'][idx(l)]);

/** Returns rows with translated column keys, and the money column list mapped accordingly. */
export function localizeRows(rows: Record<string, unknown>[], money: string[], l: string | null) {
  const i = idx(l);
  if (i === 0 || !rows.length) return { rows, money };
  const map = (k: string) => C[k]?.[i] ?? k;
  return { rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [map(k), v]))), money: money.map(map) };
}
