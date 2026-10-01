// A static, illustrative rendering of the records view for the made-up demo company,
// Fernhollow Foods. It is drawn in HTML so it stays sharp and needs no image assets.

const rows = [
  { key: "FIN-142", title: "Invoice exception: chili pepper supplier", vendor: "Ancho & Co", amount: "$4,820.00", priority: "high", who: "Dana R." },
  { key: "FIN-141", title: "Freight overcharge on cold brew pallets", vendor: "Northline Haul", amount: "$1,265.40", priority: "medium", who: "Sam K." },
  { key: "FIN-140", title: "Duplicate invoice for jar lids", vendor: "LidCo", amount: "$918.00", priority: "low", who: "Unassigned" },
  { key: "FIN-139", title: "Price mismatch: smoked paprika", vendor: "Saffron Ltd", amount: "$2,104.75", priority: "urgent", who: "Dana R." },
  { key: "FIN-138", title: "Missing PO on label stock order", vendor: "PrintWorks", amount: "$640.00", priority: "medium", who: "Lee M." },
  { key: "FIN-137", title: "Short shipment: glass bottles", vendor: "ClearGlass", amount: "$3,377.20", priority: "high", who: "Sam K." },
];

export function ProductPreview() {
  return (
    <div className="preview" aria-label="Preview of the AP Requests queue for Fernhollow Foods">
      <div className="preview-head">
        <div>
          <div className="preview-title">AP Requests</div>
          <div className="preview-sub">Fernhollow Foods · Invoice exceptions · 6 open</div>
        </div>
        <span className="preview-btn">New record</span>
      </div>
      <div className="preview-filters">
        <span>All projects ▾</span>
        <span>Assigned to me ▾</span>
        <span className="preview-search">Search title, key or description</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Title</th>
            <th>Vendor</th>
            <th className="num">Amount</th>
            <th>Priority</th>
            <th>Assignee</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="k">{r.key}</td>
              <td>{r.title}</td>
              <td>{r.vendor}</td>
              <td className="num">{r.amount}</td>
              <td>
                <span className={`pill ${r.priority}`}>{r.priority}</span>
              </td>
              <td>{r.who}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
